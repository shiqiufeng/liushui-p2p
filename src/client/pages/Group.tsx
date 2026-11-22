import {
  RiArrowLeftLine,
  RiCameraLine,
  RiCameraOffLine,
  RiChat3Line,
  RiCloseLine,
  RiFileCopyLine,
  RiGroupLine,
  RiLock2Fill,
  RiMacLine,
  RiMicLine,
  RiMicOffLine,
  RiSendPlane2Fill,
} from "@remixicon/react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Layout from "../components/Layout";
import { MeshRoom, type MeshPeer, type MeshSnapshot } from "../lib/mesh";

/**
 * 多人房（mesh）。
 *
 * 与双人房分开的一条路径：双人房保留原有的 NativeWebRTCSession（一条 PC、
 * 全套文件/画板/远程控制），多人房用 mesh —— 每个对端一条 PC，按 slotId
 * 字典序决定谁发 offer，天然避开双方同时 offer 的冲突。
 *
 * 这里只放多人真正需要的东西：屏幕共享、摄像头、麦克风、文本聊天。
 * 文件传输、画板、远程控制仍然只在双人房，避免半成品互相拖累。
 */

type Copy = {
  lobbyTitle: string;
  lobbyHint: string;
  join: string;
  back: string;
  room: string;
  copyLink: string;
  copied: string;
  participants: string;
  encrypted: string;
  verifying: string;
  waitingPeer: string;
  waitingShare: string;
  selfPreview: string;
  share: string;
  stopShare: string;
  camera: string;
  cameraOff: string;
  mic: string;
  micOff: string;
  chat: string;
  chatPlaceholder: string;
  send: string;
  emptyChat: string;
  full: string;
  fullHint: string;
  needCode: string;
  seats: string;
  seatsHint: string;
  shareFailed: string;
  camFailed: string;
  micFailed: string;
  you: string;
};

const copyZh: Copy = {
  lobbyTitle: "多人房",
  lobbyHint: "输入同一个六位数字即可进入，人数上限由创建者决定（2-6 人）。",
  join: "进入房间",
  back: "返回",
  room: "房间",
  copyLink: "复制邀请链接",
  copied: "已复制",
  participants: "在线",
  encrypted: "端到端加密",
  verifying: "正在校验",
  waitingPeer: "等待其他人加入…",
  waitingShare: "还没有共享画面",
  selfPreview: "本机预览",
  share: "共享屏幕",
  stopShare: "停止共享",
  camera: "关闭摄像头",
  cameraOff: "打开摄像头",
  mic: "关闭麦克风",
  micOff: "打开麦克风",
  chat: "聊天",
  chatPlaceholder: "说点什么…",
  send: "发送",
  emptyChat: "还没有消息，先打个招呼。",
  full: "房间已满",
  fullHint: "这个房间已经坐满，换一个号码或者等有人离开。",
  needCode: "请输入六位数字",
  seats: "房间人数",
  seatsHint: "2 人走双人房（文件传输、画板、远程控制全都有），3-6 人走多人房。",
  shareFailed: "无法共享屏幕，可能是权限被拒绝或浏览器不支持。",
  camFailed: "无法打开摄像头。",
  micFailed: "无法打开麦克风。",
  you: "我",
};

const copyEn: Copy = {
  lobbyTitle: "Group room",
  lobbyHint: "Share the same 6 digits. Seat count is set by whoever creates the room (2-6).",
  join: "Join room",
  back: "Back",
  room: "Room",
  copyLink: "Copy invite link",
  copied: "Copied",
  participants: "online",
  encrypted: "End-to-end encrypted",
  verifying: "Verifying",
  waitingPeer: "Waiting for others to join…",
  waitingShare: "No shared screen yet",
  selfPreview: "Your preview",
  share: "Share screen",
  stopShare: "Stop sharing",
  camera: "Turn camera off",
  cameraOff: "Turn camera on",
  mic: "Mute mic",
  micOff: "Unmute mic",
  chat: "Chat",
  chatPlaceholder: "Say something…",
  send: "Send",
  emptyChat: "No messages yet. Say hi.",
  full: "Room is full",
  fullHint: "All seats are taken. Try another code or wait for someone to leave.",
  needCode: "Enter 6 digits",
  seats: "Room size",
  seatsHint: "2 people opens the duo room (files, whiteboard, remote control). 3-6 opens the group room.",
  shareFailed: "Screen sharing failed — permission denied or unsupported browser.",
  camFailed: "Could not open the camera.",
  micFailed: "Could not open the microphone.",
  you: "You",
};

type ChatEntry = { id: string; mine: boolean; peerId?: string; text: string; at: number };

function attachStream(element: HTMLVideoElement | HTMLAudioElement | null, stream: MediaStream | null) {
  if (!element) return;
  if (element.srcObject !== stream) element.srcObject = stream;
  if (stream && element instanceof HTMLVideoElement) void element.play().catch(() => undefined);
}

const SEAT_OPTIONS = [2, 3, 4, 5, 6] as const;

function Lobby({ locale, copy }: { locale: "zh" | "en"; copy: Copy }) {
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [seats, setSeats] = useState(6);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setError(copy.needCode);
      return;
    }
    if (seats === 2) {
      void navigate({ to: locale === "zh" ? "/zh/room/$roomId" : "/en/room/$roomId", params: { roomId: code } });
      return;
    }
    void navigate({
      to: locale === "zh" ? "/zh/group/$roomId" : "/en/group/$roomId",
      params: { roomId: code },
      search: { cap: seats },
    });
  };

  return (
    <div className="flex h-full w-full items-center justify-center px-5">
      <form className="glass w-full max-w-md rounded-3xl p-8" onSubmit={submit}>
        <div className="flex items-center gap-3">
          <img alt="" aria-hidden="true" className="h-24 w-auto drop-shadow-[0_10px_24px_rgba(0,0,0,0.6)]" src="/art/mascot.webp" />
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-white">{copy.lobbyTitle}</h1>
            <p className="mt-1 text-xs leading-relaxed text-sky-100/50">{copy.lobbyHint}</p>
          </div>
        </div>
        <input
          autoFocus
          className="mt-6 w-full rounded-xl border border-white/10 bg-black/35 px-4 py-3 text-center text-2xl tracking-[0.5em] text-white outline-none transition focus:border-sky-300/60 focus:shadow-[0_0_0_3px_rgba(103,213,255,0.14)]"
          inputMode="numeric"
          maxLength={6}
          onChange={(event) => {
            setCode(event.target.value.replace(/\D/g, "").slice(0, 6));
            setError(null);
          }}
          placeholder="000000"
          value={code}
        />
        <div className="mt-5">
          <div className="flex items-baseline justify-between">
            <span className="text-[11px] font-semibold tracking-[0.08em] text-sky-100/60">{copy.seats}</span>
            <span className="font-mono text-xs text-sky-100/45">{seats} / 6</span>
          </div>
          <div className="mt-2 grid grid-cols-5 gap-1.5">
            {SEAT_OPTIONS.map((option) => {
              const active = option === seats;
              return (
                <button
                  key={option}
                  aria-pressed={active}
                  className={`rounded-lg border py-2.5 text-sm font-semibold transition ${
                    active
                      ? "border-sky-300/70 bg-sky-300/15 text-sky-50"
                      : "border-white/10 bg-white/[0.06] text-sky-100/90 hover:border-white/30 hover:text-sky-50"
                  }`}
                  onClick={() => setSeats(option)}
                  type="button"
                >
                  {option}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-sky-100/40">{copy.seatsHint}</p>
        </div>
        {error ? <p className="mt-2 text-xs text-amber-300/90">{error}</p> : null}
        <button
          className="mt-4 w-full rounded-xl bg-gradient-to-b from-sky-300 to-sky-500 px-4 py-3 text-sm font-semibold text-slate-900 transition hover:brightness-105 active:translate-y-px"
          type="submit"
        >
          {copy.join}
        </button>
        <button
          className="mt-3 w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-xs text-sky-100/70 transition hover:bg-white/10"
          onClick={() => void navigate({ to: locale === "zh" ? "/zh" : "/en" })}
          type="button"
        >
          {copy.back}
        </button>
      </form>
    </div>
  );
}

function PeerTile({ copy, peer }: { copy: Copy; peer: MeshPeer }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stream = peer.screen ?? peer.camera;

  useEffect(() => {
    attachStream(videoRef.current, stream);
  }, [stream]);

  const encrypted = peer.e2ee.state === "ready";
  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/[0.07] bg-black/45">
      {stream ? (
        <video ref={videoRef} autoPlay className="h-full w-full object-contain" muted playsInline />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-4 text-center">
          <img alt="" aria-hidden="true" className="h-20 w-auto opacity-70" src="/art/mascot.webp" />
          <p className="text-[11.5px] tracking-[0.04em] text-sky-100/45">{copy.waitingShare}</p>
        </div>
      )}
      <div className="pointer-events-none absolute left-2.5 top-2.5 flex items-center gap-1.5 rounded-full border border-white/10 bg-black/55 px-2.5 py-1 backdrop-blur">
        <span className={`size-1.5 rounded-full ${peer.state === "online" ? "bg-emerald-400" : "bg-amber-400"}`} />
        <span className="font-mono text-[10px] text-sky-100/80">{peer.peerId.slice(0, 4)}</span>
        {encrypted ? <span className="font-mono text-[10px] text-emerald-300/90">{peer.e2ee.sas}</span> : null}
      </div>
      <audio autoPlay ref={(element) => attachStream(element, peer.audio)} />
    </div>
  );
}

function parseCapacity(value: unknown, fallback = 6): number {
  const raw = typeof value === "string" ? Number.parseInt(value, 10) : typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(6, Math.max(2, Math.floor(raw)));
}

export default function Group({ locale, roomId }: { locale: "zh" | "en"; roomId?: string }) {
  const copy = locale === "zh" ? copyZh : copyEn;
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { cap?: unknown };
  const capacity = useMemo(() => parseCapacity(search.cap), [search.cap]);
  const meshRef = useRef<MeshRoom | null>(null);
  const [snapshot, setSnapshot] = useState<MeshSnapshot>({ peers: [], selfId: null, state: "connecting", detail: null, capacity: 6 });
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const encrypted = snapshot.peers.length > 0 && snapshot.peers.every((peer) => peer.e2ee.state === "ready");

  useEffect(() => {
    if (!roomId) return;
    const mesh = new MeshRoom(roomId, {
      onSnapshot: setSnapshot,
      onChat: (message) => {
        setMessages((current) => [...current, { id: message.id, mine: false, peerId: message.peerId, text: message.text, at: message.sentAt }]);
      },
      onError: (message) => setNotice(message),
    }, capacity);
    meshRef.current = mesh;
    mesh.connect();
    return () => {
      mesh.close();
      meshRef.current = null;
    };
  }, [roomId, capacity]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const stopTracks = useCallback((stream: MediaStream | null) => {
    stream?.getTracks().forEach((track) => track.stop());
  }, []);

  const toggleScreen = useCallback(async () => {
    const mesh = meshRef.current;
    if (!mesh) return;
    if (screenStream) {
      stopTracks(screenStream);
      setScreenStream(null);
      await mesh.publish("screen-video", null);
      await mesh.publish("screen-audio", null);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      setScreenStream(stream);
      await mesh.publish("screen-video", stream.getVideoTracks()[0] ?? null);
      await mesh.publish("screen-audio", stream.getAudioTracks()[0] ?? null);
      const video = stream.getVideoTracks()[0];
      if (video) video.onended = () => {
        setScreenStream(null);
        void mesh.publish("screen-video", null);
        void mesh.publish("screen-audio", null);
      };
    } catch {
      setNotice(copy.shareFailed);
    }
  }, [copy.shareFailed, screenStream, stopTracks]);

  const toggleCamera = useCallback(async () => {
    const mesh = meshRef.current;
    if (!mesh) return;
    if (cameraStream) {
      stopTracks(cameraStream);
      setCameraStream(null);
      await mesh.publish("camera-video", null);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 } } });
      setCameraStream(stream);
      await mesh.publish("camera-video", stream.getVideoTracks()[0] ?? null);
    } catch {
      setNotice(copy.camFailed);
    }
  }, [cameraStream, copy.camFailed, stopTracks]);

  const toggleMic = useCallback(async () => {
    const mesh = meshRef.current;
    if (!mesh) return;
    if (micStream) {
      stopTracks(micStream);
      setMicStream(null);
      await mesh.publish("camera-audio", null);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setMicStream(stream);
      await mesh.publish("camera-audio", stream.getAudioTracks()[0] ?? null);
    } catch {
      setNotice(copy.micFailed);
    }
  }, [copy.micFailed, micStream, stopTracks]);

  useEffect(() => () => {
    stopTracks(screenStream);
    stopTracks(cameraStream);
    stopTracks(micStream);
  }, [screenStream, cameraStream, micStream, stopTracks]);

  const send = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    const id = crypto.randomUUID();
    setMessages((current) => [...current, { id, mine: true, text, at: Date.now() }]);
    meshRef.current?.sendChat(id, text);
    setDraft("");
  };

  const copyLink = async () => {
    const url = `${window.location.origin}/${locale}/group/${roomId}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_800);
    } catch {
      setNotice(url);
    }
  };

  const localPreview = screenStream ?? cameraStream;
  const previewRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    attachStream(previewRef.current, localPreview);
  }, [localPreview]);

  const columns = useMemo(() => (snapshot.peers.length <= 1 ? 1 : snapshot.peers.length === 2 ? 2 : 3), [snapshot.peers.length]);

  if (!roomId) {
    return (
      <Layout title={copy.lobbyTitle}>
        <Lobby copy={copy} locale={locale} />
      </Layout>
    );
  }

  return (
    <Layout title={`${copy.lobbyTitle} · ${roomId}`}>
      <div className="flex h-full min-h-0 w-full flex-col">
        <header className="flex shrink-0 items-center gap-3 px-4 py-3 sm:px-6">
          <button
            aria-label={copy.back}
            className="grid size-9 place-items-center rounded-xl border border-white/10 bg-white/5 text-sky-100/70 transition hover:bg-white/10"
            onClick={() => void navigate({ to: locale === "zh" ? "/zh" : "/en" })}
            type="button"
          >
            <RiArrowLeftLine aria-hidden="true" className="size-4" />
          </button>
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold tracking-tight text-white">{copy.lobbyTitle}</span>
            <span className="font-mono text-[13px] tracking-[0.28em] text-sky-200/80">{roomId}</span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-sky-100/70 sm:inline-flex">
              <RiGroupLine aria-hidden="true" className="size-3.5" />
              {snapshot.peers.length + 1}/{snapshot.capacity} {copy.participants}
            </span>
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] ${encrypted ? "border-emerald-300/25 bg-emerald-400/10 text-emerald-300" : "border-amber-300/25 bg-amber-400/10 text-amber-300"}`}>
              <RiLock2Fill aria-hidden="true" className="size-3" />
              {encrypted ? copy.encrypted : copy.verifying}
            </span>
            <button
              aria-label={copy.copyLink}
              className="grid size-9 place-items-center rounded-xl border border-white/10 bg-white/5 text-sky-100/70 transition hover:bg-white/10"
              onClick={() => void copyLink()}
              type="button"
            >
              <RiFileCopyLine aria-hidden="true" className="size-4" />
            </button>
            <button
              aria-label={copy.chat}
              className="grid size-9 place-items-center rounded-xl border border-white/10 bg-white/5 text-sky-100/70 transition hover:bg-white/10 lg:hidden"
              onClick={() => setChatOpen((open) => !open)}
              type="button"
            >
              <RiChat3Line aria-hidden="true" className="size-4" />
            </button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 gap-3 px-4 pb-24 sm:px-6">
          <main className="min-h-0 flex-1">
            {snapshot.peers.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
                <img alt="" aria-hidden="true" className="h-40 w-auto opacity-80 drop-shadow-[0_20px_40px_rgba(0,0,0,0.6)]" src="/art/mascot.webp" />
                <p className="text-sm tracking-[0.04em] text-sky-100/50">{copy.waitingPeer}</p>
                <p className="text-[11px] text-sky-100/30">{copy.lobbyHint}</p>
              </div>
            ) : (
              <div
                className="grid h-full min-h-0 gap-3"
                style={{
                  gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                  gridAutoRows: "minmax(0, 1fr)",
                }}
              >
                {snapshot.peers.map((peer) => (
                  <PeerTile copy={copy} key={peer.peerId} peer={peer} />
                ))}
              </div>
            )}
          </main>

          <aside className={`${chatOpen ? "flex" : "hidden"} absolute inset-x-4 bottom-24 top-20 z-30 flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#050b12]/95 backdrop-blur-xl lg:static lg:z-auto lg:flex lg:w-[300px] lg:rounded-2xl lg:bg-black/30`}>
            <div className="flex items-center justify-between border-b border-white/[0.06] px-3 py-2">
              <span className="text-[11px] font-medium tracking-[0.16em] text-sky-100/50 uppercase">{copy.chat}</span>
              <button
                aria-label="close"
                className="grid size-7 place-items-center rounded-lg text-sky-100/40 hover:bg-white/10 lg:hidden"
                onClick={() => setChatOpen(false)}
                type="button"
              >
                <RiCloseLine aria-hidden="true" className="size-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
              {messages.length === 0 ? (
                <p className="pt-6 text-center text-[11px] text-sky-100/30">{copy.emptyChat}</p>
              ) : (
                messages.map((message) => (
                  <div className={`max-w-[92%] rounded-xl px-3 py-2 text-[12.5px] leading-relaxed ${message.mine ? "ml-auto bg-sky-400/15 text-sky-50" : "bg-white/[0.06] text-slate-100/90"}`} key={message.id}>
                    <div className="mb-0.5 text-[9.5px] tracking-[0.12em] text-sky-100/35 uppercase">
                      {message.mine ? copy.you : message.peerId?.slice(0, 4)}
                    </div>
                    {message.text}
                  </div>
                ))
              )}
            </div>
            <form className="flex items-center gap-2 border-t border-white/[0.06] p-2" onSubmit={send}>
              <input
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-[12.5px] text-white outline-none focus:border-sky-300/50"
                onChange={(event) => setDraft(event.target.value)}
                placeholder={copy.chatPlaceholder}
                value={draft}
              />
              <button aria-label={copy.send} className="grid size-9 shrink-0 place-items-center rounded-lg bg-sky-400/20 text-sky-200 transition hover:bg-sky-400/30" type="submit">
                <RiSendPlane2Fill aria-hidden="true" className="size-4" />
              </button>
            </form>
          </aside>
        </div>

        {localPreview ? (
          <div className="pointer-events-none absolute bottom-24 left-4 z-20 w-40 overflow-hidden rounded-xl border border-white/10 bg-black/60 shadow-[0_16px_40px_rgba(0,0,0,0.5)] sm:left-6">
            <video ref={previewRef} autoPlay className="h-full w-full object-cover" muted playsInline />
            <span className="absolute left-2 top-1.5 text-[9.5px] tracking-[0.14em] text-white/70 uppercase">{copy.selfPreview}</span>
          </div>
        ) : null}

        <div className="pointer-events-none absolute inset-x-0 bottom-5 z-30 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-1.5 rounded-2xl border border-white/10 bg-[#05090f]/85 px-2 py-2 shadow-[0_18px_50px_rgba(0,0,0,0.6)] backdrop-blur-xl">
            <button
              className={`flex items-center gap-2 rounded-xl px-3 py-2 text-[12px] transition ${screenStream ? "bg-sky-400/20 text-sky-200" : "text-sky-100/70 hover:bg-white/10"}`}
              onClick={() => void toggleScreen()}
              type="button"
            >
              <RiMacLine aria-hidden="true" className="size-4" />
              <span className="hidden sm:inline">{screenStream ? copy.stopShare : copy.share}</span>
            </button>
            <button
              className={`flex items-center gap-2 rounded-xl px-3 py-2 text-[12px] transition ${cameraStream ? "bg-sky-400/20 text-sky-200" : "text-sky-100/70 hover:bg-white/10"}`}
              onClick={() => void toggleCamera()}
              type="button"
            >
              {cameraStream ? <RiCameraLine aria-hidden="true" className="size-4" /> : <RiCameraOffLine aria-hidden="true" className="size-4" />}
              <span className="hidden sm:inline">{cameraStream ? copy.camera : copy.cameraOff}</span>
            </button>
            <button
              className={`flex items-center gap-2 rounded-xl px-3 py-2 text-[12px] transition ${micStream ? "bg-sky-400/20 text-sky-200" : "text-sky-100/70 hover:bg-white/10"}`}
              onClick={() => void toggleMic()}
              type="button"
            >
              {micStream ? <RiMicLine aria-hidden="true" className="size-4" /> : <RiMicOffLine aria-hidden="true" className="size-4" />}
              <span className="hidden sm:inline">{micStream ? copy.mic : copy.micOff}</span>
            </button>
            <span className={`ml-1 rounded-full px-2 py-1 text-[10px] font-medium ${copied ? "bg-emerald-400/20 text-emerald-300" : "bg-white/5 text-sky-100/40"}`}>
              {copied ? copy.copied : `#${roomId}`}
            </span>
          </div>
        </div>

        {notice ? (
          <div className="absolute left-1/2 top-16 z-40 -translate-x-1/2 rounded-xl border border-amber-300/25 bg-amber-400/10 px-4 py-2 text-[12px] text-amber-200 backdrop-blur">
            {notice}
          </div>
        ) : null}

        {snapshot.state === "full" ? (
          <div className="absolute inset-0 z-50 grid place-items-center bg-black/80 backdrop-blur-sm">
            <div className="glass max-w-sm rounded-2xl p-7 text-center">
              <h2 className="text-lg font-semibold text-white">{copy.full}</h2>
              <p className="mt-2 text-xs leading-relaxed text-sky-100/55">{copy.fullHint}</p>
              <button
                className="mt-5 w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-xs text-sky-100/70 hover:bg-white/10"
                onClick={() => void navigate({ to: locale === "zh" ? "/zh" : "/en" })}
                type="button"
              >
                {copy.back}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </Layout>
  );
}
