import { E2EESession, E2EE_HANDSHAKE_TYPE, extractDtlsFingerprint, type E2EEStatus } from "./e2ee";
import { MediaTransport, type MediaSlotId, type MediaSlotSnapshot } from "./media-transport";
import { prepareIceServersForConnection } from "./webrtc";
import {
  SIGNALING_HEARTBEAT_CAPABILITY,
  SIGNALING_HEARTBEAT_INTERVAL_MS,
  SIGNALING_HEARTBEAT_REQUEST,
  SIGNALING_HEARTBEAT_RESPONSE,
} from "../../shared/signaling-protocol";

/**
 * 多人房（mesh）传输层。
 *
 * 与 1:1 的 NativeWebRTCSession 分开实现，原因很直接：
 * - 1:1 那套里「对端」是单数：一个 RTCPeerConnection、一组 data channel、
 *   一个 MediaTransport。多人房间里每个对端都要有一整套，硬塞进原类会把
 *   已经稳定的双人链路也一起改坏。
 * - 这里只保留多人真正需要的东西：信令复用一条 WebSocket、每对端一条
 *   PC、六条固定 RTP 槽位、应用层 E2EE、文本聊天。文件传输 / 画板 / 远程
 *   控制仍然留在双人房，避免半成品功能互相拖累。
 *
 * 协商规则：每个对端各自一条 PC，用 slotId 字典序决定谁发 offer，
 * 双方算出来必然一致，不会出现 glare（双向同时 offer）。
 */

const DATA_CHANNEL_NAMES = ["bulk", "collaboration", "control", "interactive"] as const;
type DataChannelName = typeof DATA_CHANNEL_NAMES[number];
const MAX_PEERS = 6;

type SignalPayload = {
  candidate?: RTCIceCandidateInit;
  description?: RTCSessionDescriptionInit;
};

type ServerMessage = {
  type?: string;
  code?: string;
  message?: string;
  slotId?: string;
  peerId?: string;
  peerSessionId?: string;
  fromSlotId?: string;
  peers?: Array<{ slotId?: string; peerSessionId?: string }>;
  payload?: SignalPayload;
  peerCount?: number;
  capacity?: number;
  roomMode?: string;
  resumeToken?: string;
};

export type MeshPeerState = "connecting" | "online" | "offline";

export type MeshPeer = {
  peerId: string;
  state: MeshPeerState;
  e2ee: E2EEStatus;
  screen: MediaStream | null;
  camera: MediaStream | null;
  audio: MediaStream | null;
  active: boolean;
};

export type MeshSnapshot = {
  peers: MeshPeer[];
  selfId: string | null;
  state: "connecting" | "online" | "reconnecting" | "full" | "closed" | "error";
  detail: string | null;
};

export type MeshChatMessage = { id: string; peerId: string; text: string; sentAt: number };

type MeshHandlers = {
  onChat?: (message: MeshChatMessage) => void;
  onError?: (message: string) => void;
  onSnapshot?: (snapshot: MeshSnapshot) => void;
  onRoomFull?: () => void;
};

function websocketUrl(roomId: string): string {
  const url = new URL(`/api/rooms/${roomId}/ws`, window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function asCandidate(candidate: RTCIceCandidate): RTCIceCandidateInit {
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
    usernameFragment: candidate.usernameFragment,
  };
}

function isHandshake(value: unknown): boolean {
  if (typeof value !== "string" || !value.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(value) as { type?: string };
    return parsed.type === E2EE_HANDSHAKE_TYPE;
  } catch {
    return false;
  }
}

/** 单个对端的完整链路：一条 PC + 四条 data channel + 一套媒体槽位 + 一份 E2EE 会话。 */
class PeerLink {
  private pc: RTCPeerConnection | null = null;
  private readonly channels: Record<DataChannelName, RTCDataChannel | null> = {
    bulk: null,
    collaboration: null,
    control: null,
    interactive: null,
  };
  private readonly media: MediaTransport;
  private readonly e2ee = new E2EESession();
  private readonly pending: SignalPayload[] = [];
  private readonly pendingSealed: Array<{ name: DataChannelName; data: ArrayBuffer }> = [];
  private flushing = false;
  private openChannels = 0;
  private closed = false;
  private e2eeSendChain: Promise<void> = Promise.resolve();
  private e2eeReceiveChain: Promise<void> = Promise.resolve();

  constructor(
    readonly peerId: string,
    private readonly initiator: boolean,
    private readonly iceServers: RTCIceServer[],
    private readonly sendSignal: (payload: SignalPayload) => void,
    private readonly onChat: (message: MeshChatMessage) => void,
    private readonly onStateChange: () => void,
    private readonly localTracks: () => Partial<Record<MediaSlotId, MediaStreamTrack | null>>,
    private readonly onFailed: () => void,
  ) {
    this.media = new MediaTransport(
      (message) => this.sendRaw("control", JSON.stringify(message)),
      undefined,
      () => undefined,
    );
    this.media.subscribe(() => this.onStateChange());
  }

  get connected(): boolean {
    return this.openChannels >= DATA_CHANNEL_NAMES.length;
  }

  get peerState(): MeshPeerState {
    if (this.closed) return "offline";
    return this.connected ? "online" : "connecting";
  }

  get status(): E2EEStatus {
    return this.e2ee.status;
  }

  get screen(): MediaStream | null {
    return this.media.getRemoteStream("screen-video") ?? null;
  }

  get camera(): MediaStream | null {
    return this.media.getRemoteStream("camera-video") ?? null;
  }

  get audio(): MediaStream | null {
    return this.media.getRemoteStream("screen-audio") ?? this.media.getRemoteStream("camera-audio") ?? null;
  }

  get mediaSlots(): MediaSlotSnapshot[] {
    return this.media.snapshots;
  }

  async start(): Promise<void> {
    if (this.closed || this.pc) return;
    const pc = this.createPeer();
    if (this.initiator) {
      this.media.prepareOffer(pc);
      for (const name of DATA_CHANNEL_NAMES) {
        this.attachChannel(pc.createDataChannel(name, { ordered: name !== "bulk" }));
      }
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.sendSignal({ description: offer });
    }
    await this.applyLocalTracks(this.localTracks());
  }

  async applyLocalTracks(tracks: Partial<Record<MediaSlotId, MediaStreamTrack | null>>): Promise<void> {
    for (const [slot, track] of Object.entries(tracks) as Array<[MediaSlotId, MediaStreamTrack | null]>) {
      await this.replaceLocalTrack(slot, track);
    }
  }

  async replaceLocalTrack(slot: MediaSlotId, track: MediaStreamTrack | null): Promise<void> {
    if (!this.pc) return;
    try {
      await this.media.replaceLocalTrack(slot, track, track ? "live" : "idle");
    } catch {
      // 槽位尚未绑定 sender 时忽略：新一轮协商结束后会重新应用
    }
  }

  receive(payload: SignalPayload): void {
    if (this.closed) return;
    this.pending.push(payload);
    void this.flush();
  }

  sendChat(id: string, text: string): boolean {
    return this.sendRaw("interactive", JSON.stringify({ id, text, type: "chat" }));
  }

  private createPeer(): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pc = pc;
    pc.onicecandidate = ({ candidate }) => {
      if (candidate && this.pc === pc && !this.closed) this.sendSignal({ candidate: asCandidate(candidate) });
    };
    pc.ontrack = (event) => {
      if (this.pc !== pc || this.closed) return;
      this.media.handleRemoteTrack(event);
      this.onStateChange();
    };
    pc.ondatachannel = ({ channel }) => {
      if (this.pc === pc && !this.closed) this.attachChannel(channel);
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc || this.closed) return;
      if (pc.connectionState === "failed") {
        this.onFailed();
        return;
      }
      this.onStateChange();
    };
    return pc;
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.closed) return;
    this.flushing = true;
    try {
      while (this.pending.length > 0 && !this.closed) {
        const payload = this.pending.shift();
        if (!payload) continue;
        const pc = this.pc ?? this.createPeer();
        if (payload.description) {
          if (payload.description.type === "offer" && pc.signalingState === "have-local-offer") {
            await pc.setLocalDescription({ type: "rollback" });
          }
          await pc.setRemoteDescription(payload.description);
          if (payload.description.type === "offer") {
            this.media.bindIncomingPeer(pc);
            // 槽位绑定完成后才能 replaceTrack；不补这一步，后进入的人
            // 收不到应答方已经在共享的画面。
            void this.applyLocalTracks(this.localTracks());
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            this.sendSignal({ description: answer });
          }
        }
        if (payload.candidate) {
          if (pc.remoteDescription) await pc.addIceCandidate(payload.candidate);
          else {
            // 描述还没到：留在队列里，等 offer/answer 处理完再回来
            this.pending.unshift({ candidate: payload.candidate });
            break;
          }
        }
      }
    } catch {
      // 协商失败时重建这条链路，其他对端不受影响
      this.onStateChange();
    } finally {
      this.flushing = false;
    }
  }

  private attachChannel(channel: RTCDataChannel): void {
    const name = channel.label as DataChannelName;
    if (!DATA_CHANNEL_NAMES.includes(name)) {
      channel.close();
      return;
    }
    const previous = this.channels[name];
    if (previous && previous !== channel) {
      previous.onclose = null;
      try {
        previous.close();
      } catch {
        // 已关闭
      }
    }
    this.channels[name] = channel;
    channel.binaryType = "arraybuffer";
    channel.onopen = () => {
      if (this.channels[name] !== channel || this.closed) return;
      if (!previous) this.openChannels += 1;
      if (name === "control") void this.startHandshake();
      this.onStateChange();
    };
    channel.onmessage = (event) => {
      if (this.channels[name] !== channel || this.closed) return;
      const raw = event.data;
      this.e2eeReceiveChain = this.e2eeReceiveChain
        .then(() => this.route(name, raw))
        .catch(() => {
          // 解密失败（篡改 / 重放 / 乱序）只丢弃这一条
        });
    };
    channel.onclose = () => {
      if (this.channels[name] !== channel) return;
      this.openChannels = Math.max(0, this.openChannels - 1);
      this.onStateChange();
    };
    channel.onerror = () => this.onStateChange();
  }

  private async route(name: DataChannelName, raw: unknown): Promise<void> {
    if (raw instanceof ArrayBuffer && E2EESession.isSealedPacket(raw)) {
      if (!this.e2ee.ready) {
        if (this.pendingSealed.length < 64) this.pendingSealed.push({ name, data: raw });
        return;
      }
      const opened = await this.e2ee.open(raw);
      if (!opened) return;
      this.dispatch(name, opened.data);
      return;
    }
    if (isHandshake(raw)) {
      await this.acceptHandshake(raw as string);
      return;
    }
    this.dispatch(name, raw);
  }

  private dispatch(name: DataChannelName, raw: unknown): void {
    if (name === "control" && typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (this.media.handleControlMessage(parsed)) {
          this.onStateChange();
          return;
        }
      } catch {
        // 非 JSON 控制帧，忽略
      }
      return;
    }
    if (name === "interactive" && typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw) as { id?: unknown; text?: unknown; type?: unknown };
        if (parsed.type === "chat" && typeof parsed.id === "string" && typeof parsed.text === "string") {
          this.onChat({ id: parsed.id, peerId: this.peerId, text: parsed.text.slice(0, 4_000), sentAt: Date.now() });
        }
      } catch {
        // 忽略畸形消息
      }
    }
  }

  private async startHandshake(): Promise<void> {
    try {
      const hello = await this.e2ee.beginHandshake();
      this.writeRaw("control", JSON.stringify(hello));
    } catch {
      // 浏览器不支持 ECDH 时退化为纯 DTLS
    }
  }

  private async acceptHandshake(raw: string): Promise<void> {
    let message: { v?: number; pub?: string };
    try {
      message = JSON.parse(raw) as { v?: number; pub?: string };
    } catch {
      return;
    }
    if (message.v !== 1 || typeof message.pub !== "string" || message.pub.length === 0 || message.pub.length > 256) return;
    const pc = this.pc;
    await this.e2ee.acceptPeer(
      message.pub,
      extractDtlsFingerprint(pc?.localDescription?.sdp),
      extractDtlsFingerprint(pc?.remoteDescription?.sdp),
    );
    this.onStateChange();
    if (this.e2ee.ready && this.pendingSealed.length > 0) {
      const queued = this.pendingSealed.splice(0);
      for (const item of queued) {
        const opened = await this.e2ee.open(item.data);
        if (opened) this.dispatch(item.name, opened.data);
      }
      this.onStateChange();
    }
  }

  private sendRaw(name: DataChannelName, data: string): boolean {
    if (!this.e2ee.ready || isHandshake(data)) return this.writeRaw(name, data);
    this.e2eeSendChain = this.e2eeSendChain
      .then(async () => {
        const sealed = await this.e2ee.seal(data);
        this.writeRaw(name, sealed);
      })
      .catch(() => {
        // 单条加密失败不影响后续
      });
    return true;
  }

  private writeRaw(name: DataChannelName, data: string | ArrayBuffer): boolean {
    const channel = this.channels[name];
    if (channel?.readyState !== "open") return false;
    try {
      if (typeof data === "string") channel.send(data);
      else channel.send(data);
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.openChannels = 0;
    for (const name of DATA_CHANNEL_NAMES) {
      const channel = this.channels[name];
      if (channel) {
        channel.onclose = null;
        channel.onmessage = null;
        try {
          channel.close();
        } catch {
          // 已关闭
        }
      }
      this.channels[name] = null;
    }
    try {
      this.pc?.close();
    } catch {
      // 已关闭
    }
    this.pc = null;
    this.media.dispose();
  }
}

export class MeshRoom {
  private socket: WebSocket | null = null;
  private socketGeneration = 0;
  private readonly links = new Map<string, PeerLink>();
  private readonly pendingByPeer = new Map<string, SignalPayload[]>();
  private readonly retries = new Map<string, number>();
  private iceServers: RTCIceServer[] = [];
  private iceReady: Promise<void> | null = null;
  private heartbeat: number | undefined;
  private heartbeatAt: number | null = null;
  private heartbeatMisses = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: number | undefined;
  private resumeToken: string | null = null;
  private snapshot: MeshSnapshot = { peers: [], selfId: null, state: "connecting", detail: null };
  private closed = false;
  private readonly localTracks: Partial<Record<MediaSlotId, MediaStreamTrack | null>> = {};

  constructor(
    private readonly roomId: string,
    private readonly handlers: MeshHandlers = {},
  ) {}

  get snapshotValue(): MeshSnapshot {
    return { ...this.snapshot, peers: this.snapshot.peers.map((peer) => ({ ...peer })) };
  }

  get peerCount(): number {
    return this.links.size;
  }

  connect(): void {
    if (this.closed) return;
    this.openSocket(this.resumeToken ? "resume-signaling" : "new");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopHeartbeat();
    this.clearReconnect();
    this.socketGeneration += 1;
    try {
      this.socket?.send(JSON.stringify({ type: "leave" }));
    } catch {
      // 已断开
    }
    try {
      this.socket?.close(1_000, "Leaving room");
    } catch {
      // 已关闭
    }
    this.socket = null;
    this.closeAllLinks();
    this.emit("closed", null);
  }

  sendChat(id: string, text: string): boolean {
    let delivered = false;
    for (const link of this.links.values()) {
      if (link.connected && link.sendChat(id, text)) delivered = true;
    }
    return delivered;
  }

  /** 把本地采集轨道同步到所有对端；传 null 表示停止该路。 */
  async publish(slot: MediaSlotId, track: MediaStreamTrack | null): Promise<void> {
    this.localTracks[slot] = track;
    await Promise.all([...this.links.values()].map((link) => link.replaceLocalTrack(slot, track)));
  }

  private openSocket(mode: "new" | "resume-signaling"): void {
    if (this.closed) return;
    this.clearReconnect();
    this.stopHeartbeat();
    const generation = ++this.socketGeneration;
    try {
      const socket = new WebSocket(websocketUrl(this.roomId));
      this.socket = socket;
      this.emit("connecting", null);
      socket.onopen = () => {
        if (generation !== this.socketGeneration || this.closed) return;
        const hello: Record<string, unknown> = {
          type: "hello",
          mode,
          roomMode: "group",
          capabilities: [SIGNALING_HEARTBEAT_CAPABILITY],
        };
        if (mode === "resume-signaling" && this.resumeToken) hello.resumeToken = this.resumeToken;
        try {
          socket.send(JSON.stringify(hello));
        } catch {
          socket.close();
        }
        void this.prepareIce();
      };
      socket.onmessage = (event) => {
        if (generation !== this.socketGeneration || this.closed) return;
        this.handleMessage(String(event.data));
      };
      socket.onclose = () => {
        if (generation !== this.socketGeneration || this.closed) return;
        this.socket = null;
        this.stopHeartbeat();
        this.scheduleReconnect();
      };
      socket.onerror = () => {
        if (generation !== this.socketGeneration || this.closed) return;
        try {
          socket.close();
        } catch {
          // onclose 会处理重连
        }
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  private async prepareIce(): Promise<void> {
    if (this.iceReady) return this.iceReady;
    this.iceReady = (async () => {
      try {
        const prepared = await prepareIceServersForConnection();
        this.iceServers = prepared.servers;
      } catch {
        this.iceServers = [];
      }
      for (const link of this.links.values()) void link.applyLocalTracks(this.localTracks);
    })();
    return this.iceReady;
  }

  private handleMessage(raw: string): void {
    if (raw === SIGNALING_HEARTBEAT_RESPONSE || raw === "pong") {
      this.heartbeatAt = null;
      this.heartbeatMisses = 0;
      return;
    }
    let message: ServerMessage;
    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }

    if (message.type === "welcome") {
      this.snapshot.selfId = message.slotId ?? message.peerId ?? this.snapshot.selfId;
      if (typeof message.resumeToken === "string") this.resumeToken = message.resumeToken;
      this.reconnectAttempt = 0;
      this.startHeartbeat(this.socketGeneration);
      this.emit("online", null);
      return;
    }

    if (message.type === "peer-ready" || message.type === "negotiate") {
      const list = message.peers?.length
        ? message.peers
        : message.slotId
          ? [{ slotId: message.slotId, peerSessionId: message.peerSessionId }]
          : [];
      for (const peer of list) {
        if (peer.slotId && peer.slotId !== this.snapshot.selfId) this.ensurePeer(peer.slotId);
      }
      return;
    }

    if (message.type === "peer-left" || message.type === "peer-disconnected") {
      const peerId = message.slotId ?? message.peerId;
      if (peerId) {
        if (message.type === "peer-left") this.dropPeer(peerId);
        else this.emit(this.snapshot.state, null);
      }
      return;
    }

    if (message.type === "signal") {
      const from = message.fromSlotId ?? message.slotId ?? message.peerId;
      if (!from || from === this.snapshot.selfId || !message.payload) return;
      const link = this.ensurePeer(from);
      if (!link) {
        const queue = this.pendingByPeer.get(from) ?? [];
        if (queue.length < 64) queue.push(message.payload);
        this.pendingByPeer.set(from, queue);
        return;
      }
      link.receive(message.payload);
      return;
    }

    if (message.type === "error") {
      if (message.code === "room-full" || message.code === "room-reserved") {
        this.handlers.onRoomFull?.();
        this.emit("full", message.message ?? "房间已满");
        return;
      }
      if (message.code === "mode-mismatch") {
        this.emit("error", "这个房间号已经被双人房占用，请换一个号码。");
        return;
      }
      this.handlers.onError?.(message.message ?? "信令错误");
      return;
    }
  }

  private ensurePeer(peerId: string): PeerLink | null {
    if (this.closed || !this.isValidPeerId(peerId)) return null;
    const existing = this.links.get(peerId);
    if (existing) return existing;
    if (this.links.size >= MAX_PEERS - 1) return null;
    const selfId = this.snapshot.selfId;
    if (!selfId) return null;
    // 字典序小的一方发 offer，双方结论一致，不会双向同时协商
    const initiator = selfId < peerId;
    const link = new PeerLink(
      peerId,
      initiator,
      this.iceServers,
      (payload) => this.sendSignal(peerId, payload),
      (chat) => this.handlers.onChat?.(chat),
      () => this.emit(this.snapshot.state === "closed" ? "closed" : "online", this.snapshot.detail),
      () => this.localTracks,
      () => this.retryPeer(peerId),
    );
    this.links.set(peerId, link);
    void link.start();
    const queued = this.pendingByPeer.get(peerId);
    if (queued?.length) {
      this.pendingByPeer.delete(peerId);
      for (const payload of queued) link.receive(payload);
    }
    this.emit(this.snapshot.state, this.snapshot.detail);
    return link;
  }

  private isValidPeerId(peerId: string): boolean {
    return peerId.length > 0 && peerId.length <= 64;
  }

  /** 单条链路失败时重建它，最多两次，避免无限重连把 CPU 打满。 */
  private retryPeer(peerId: string): void {
    if (this.closed) return;
    const attempts = this.retries.get(peerId) ?? 0;
    if (attempts >= 2) {
      this.dropPeer(peerId);
      this.handlers.onError?.("与一位参与者的连接失败，请刷新页面重试。");
      return;
    }
    this.retries.set(peerId, attempts + 1);
    this.dropPeer(peerId);
    window.setTimeout(() => {
      if (!this.closed && this.snapshot.selfId) this.ensurePeer(peerId);
    }, 900 * (attempts + 1));
  }

  private dropPeer(peerId: string): void {
    const link = this.links.get(peerId);
    if (!link) return;
    link.close();
    this.links.delete(peerId);
    this.pendingByPeer.delete(peerId);
    this.emit(this.snapshot.state, this.snapshot.detail);
  }

  private closeAllLinks(): void {
    for (const link of this.links.values()) link.close();
    this.links.clear();
    this.pendingByPeer.clear();
  }

  private sendSignal(peerId: string, payload: SignalPayload): void {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({ type: "signal", to: peerId, payload }));
    } catch {
      // 重连后由新一轮协商补齐
    }
  }

  private startHeartbeat(generation: number): void {
    this.stopHeartbeat();
    const tick = () => {
      if (this.closed || generation !== this.socketGeneration || this.socket?.readyState !== WebSocket.OPEN) return;
      if (this.heartbeatAt !== null) {
        this.heartbeatMisses += 1;
        if (this.heartbeatMisses >= 3) {
          try {
            this.socket?.close(4_001, "Heartbeat timeout");
          } catch {
            // 忽略
          }
          return;
        }
      }
      this.heartbeatAt = performance.now();
      try {
        this.socket.send(SIGNALING_HEARTBEAT_REQUEST);
      } catch {
        // onclose 会处理
      }
    };
    tick();
    this.heartbeat = window.setInterval(tick, SIGNALING_HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== undefined) window.clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.heartbeatAt = null;
    this.heartbeatMisses = 0;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== undefined) return;
    this.emit("reconnecting", null);
    const delay = Math.min(1_000 * 2 ** this.reconnectAttempt, 8_000);
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openSocket(this.resumeToken ? "resume-signaling" : "new");
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private emit(state: MeshSnapshot["state"], detail: string | null): void {
    const peers: MeshPeer[] = [...this.links.entries()].map(([peerId, link]) => ({
      peerId,
      state: link.peerState,
      e2ee: link.status,
      screen: link.screen,
      camera: link.camera,
      audio: link.audio,
      active: Boolean(link.screen ?? link.camera),
    }));
    this.snapshot = { peers, selfId: this.snapshot.selfId, state, detail };
    this.handlers.onSnapshot?.(this.snapshotValue);
  }
}
