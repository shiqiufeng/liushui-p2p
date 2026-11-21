/**
 * 应用层端到端加密（E2EE）
 *
 * 背景：WebRTC 自带的 DTLS 只提供「链路加密」，不提供「身份认证」。
 * 任何能看到或能改写 SDP 的一方（信令服务器运营者、被篡改的部署）
 * 都可以替换 `a=fingerprint` 做中间人，两端界面依然显示正常。
 *
 * 本模块在 DTLS 之上再加一层：
 *   1. 双方各自生成临时 ECDH 密钥对（X25519，不可用时降级 P-256）
 *   2. 通过 data channel 交换公钥，协商出共享密钥，HKDF 派生出两个方向的 AES-256-GCM 密钥
 *   3. 之后所有 data channel 消息都走 AEAD 加密，中间人即使拆掉 DTLS 也拿不到明文
 *   4. 用「双方公钥 + 双方 DTLS 证书指纹」算出对称的 SAS 短码供人工比对，
 *      MITM 场景下两侧算出的 SAS 必然不同，比对即可发现
 *
 * 封包格式：magic(1) | flags(1) | counter(4, BE) | AES-GCM(ciphertext || tag)
 * nonce = 4 字节 0 || counter(4, BE) || 4 字节 0，双向使用不同密钥，nonce 空间互不重叠。
 */

const MAGIC_BYTE = 0xe2;
const FLAG_TEXT = 0x01;
const HEADER_SIZE = 6;
const NONCE_SIZE = 12;
const TAG_BITS = 128;
const HKDF_SALT = new TextEncoder().encode("liushui-e2ee-v1");
const SAS_LABEL = "liushui-sas-v1";
const MAX_COUNTER = 0xffffffff;

export const E2EE_HANDSHAKE_TYPE = "e2ee-hello";

export type E2EEState = "idle" | "handshaking" | "ready" | "failed";

export type E2EEHandshake = {
  type: typeof E2EE_HANDSHAKE_TYPE;
  v: 1;
  pub: string;
};

export type E2EEStatus = {
  state: E2EEState;
  /** 6 位十六进制短码，形如 "3F-A9-02"；未就绪时为 null */
  sas: string | null;
  curve: "X25519" | "P-256" | null;
};

type ResolvedCurve = {
  id: "X25519" | "P-256";
  generate: () => Promise<CryptoKeyPair>;
  importPublic: (raw: Bytes) => Promise<CryptoKey>;
  derive: (publicKey: CryptoKey) => EcdhKeyDeriveParams;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** WebCrypto 在 TS 5.9 下要求 BufferSource 背后的 buffer 必须是 ArrayBuffer 而非 ArrayBufferLike */
type Bytes = Uint8Array<ArrayBuffer>;

function toBase64(bytes: Bytes): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Bytes {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function concatBytes(...parts: Bytes[]): Bytes {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function compareBytes(a: Bytes, b: Bytes): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function counterToBytes(counter: number): Bytes {
  return new Uint8Array([
    (counter >>> 24) & 0xff,
    (counter >>> 16) & 0xff,
    (counter >>> 8) & 0xff,
    counter & 0xff,
  ]);
}

function bytesToCounter(view: DataView, offset: number): number {
  return view.getUint32(offset, false);
}

function buildNonce(counter: number): Bytes {
  const nonce = new Uint8Array(NONCE_SIZE);
  nonce.set(counterToBytes(counter), 4);
  return nonce;
}

const X25519_CURVE: ResolvedCurve = {
  id: "X25519",
  generate: () => crypto.subtle.generateKey({ name: "X25519" } as unknown as AlgorithmIdentifier, false, ["deriveBits"]) as Promise<CryptoKeyPair>,
  importPublic: (raw) => crypto.subtle.importKey("raw", raw, { name: "X25519" } as unknown as AlgorithmIdentifier, false, []),
  derive: (publicKey) => ({ name: "X25519", public: publicKey } as unknown as EcdhKeyDeriveParams),
};

const P256_CURVE: ResolvedCurve = {
  id: "P-256",
  generate: () => crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]) as Promise<CryptoKeyPair>,
  importPublic: (raw) => crypto.subtle.importKey("raw", raw, { name: "ECDH", namedCurve: "P-256" }, false, []),
  derive: (publicKey) => ({ name: "ECDH", public: publicKey }),
};

let cachedCurve: ResolvedCurve | null = null;

async function resolveCurve(): Promise<ResolvedCurve> {
  if (cachedCurve) return cachedCurve;
  for (const candidate of [X25519_CURVE, P256_CURVE]) {
    try {
      await candidate.generate();
      cachedCurve = candidate;
      return candidate;
    } catch {
      // 该曲线在当前浏览器不可用，继续尝试下一个
    }
  }
  throw new Error("No supported ECDH curve available");
}

async function deriveDirectionKeys(sharedBits: ArrayBuffer): Promise<{ lowToHigh: CryptoKey; highToLow: CryptoKey }> {
  const base = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
  const derive = (info: string) =>
    crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: encoder.encode(info) },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  return {
    lowToHigh: await derive("low-to-high"),
    highToLow: await derive("high-to-low"),
  };
}

/** 从 SDP 中提取 DTLS 证书的 sha-256 指纹 */
export function extractDtlsFingerprint(sdp: string | null | undefined): string {
  if (!sdp) return "";
  const match = /^a=fingerprint:sha-256\s+([0-9a-fA-F:]+)/m.exec(sdp);
  return match ? match[1].toUpperCase() : "";
}

export class E2EESession {
  private state: E2EEState = "idle";
  private curve: ResolvedCurve | null = null;
  private local: { keyPair: CryptoKeyPair; publicRaw: Bytes } | null = null;
  private peerPublicRaw: Bytes | null = null;
  private sendKey: CryptoKey | null = null;
  private receiveKey: CryptoKey | null = null;
  private sendCounter = 0;
  private receiveCounter = 0;
  private sas: string | null = null;
  private listeners = new Set<(status: E2EEStatus) => void>();

  get status(): E2EEStatus {
    return { state: this.state, sas: this.sas, curve: this.curve?.id ?? null };
  }

  get ready(): boolean {
    return this.state === "ready" && this.sendKey !== null && this.receiveKey !== null;
  }

  onStatusChange(listener: (status: E2EEStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    const status = this.status;
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch {
        // 监听器异常不应中断加密链路
      }
    }
  }

  /** 生成本地临时密钥对，返回待发送的握手消息 */
  async beginHandshake(): Promise<E2EEHandshake> {
    if (this.local) return this.handshakeMessage();
    this.state = "handshaking";
    this.notify();
    const curve = await resolveCurve();
    const keyPair = await curve.generate();
    const exported = await crypto.subtle.exportKey("raw", keyPair.publicKey);
    this.curve = curve;
    this.local = { keyPair, publicRaw: new Uint8Array(exported) };
    return this.handshakeMessage();
  }

  handshakeMessage(): E2EEHandshake {
    if (!this.local) throw new Error("Handshake has not been started");
    return { type: E2EE_HANDSHAKE_TYPE, v: 1, pub: toBase64(this.local.publicRaw) };
  }

  /** 收到对端公钥后完成密钥派生；dtlsLocal/dtlsRemote 用于计算 SAS */
  async acceptPeer(peerPublicBase64: string, dtlsLocal: string, dtlsRemote: string): Promise<void> {
    if (!this.local || !this.curve) await this.beginHandshake();
    const local = this.local;
    const curve = this.curve;
    if (!local || !curve) return;

    let peerRaw: Bytes;
    try {
      peerRaw = fromBase64(peerPublicBase64);
    } catch {
      this.state = "failed";
      this.notify();
      return;
    }
    if (peerRaw.length === 0 || compareBytes(peerRaw, local.publicRaw) === 0) {
      // 回显自己的公钥或空公钥：本次握手无效
      this.state = "failed";
      this.notify();
      return;
    }

    this.peerPublicRaw = peerRaw;
    try {
      const peerKey = await curve.importPublic(peerRaw);
      const sharedBits = await crypto.subtle.deriveBits(curve.derive(peerKey), local.keyPair.privateKey, 256);
      const keys = await deriveDirectionKeys(sharedBits);
      // 公钥字节序小的一方使用 low-to-high 发送密钥，方向由双方一致的排序决定
      const localIsLow = compareBytes(local.publicRaw, peerRaw) < 0;
      this.sendKey = localIsLow ? keys.lowToHigh : keys.highToLow;
      this.receiveKey = localIsLow ? keys.highToLow : keys.lowToHigh;
      this.sendCounter = 0;
      this.receiveCounter = 0;
      this.sas = await this.computeSas(dtlsLocal, dtlsRemote);
      this.state = "ready";
      this.notify();
    } catch {
      this.state = "failed";
      this.notify();
    }
  }

  /**
   * SAS = SHA-256(label || 排序后的双方公钥 || 排序后的双方 DTLS 指纹) 的前 3 字节。
   * 正常连接两侧算出相同值；被中间人介入时两侧材料不同，短码必然不一致。
   */
  private async computeSas(dtlsLocal: string, dtlsRemote: string): Promise<string> {
    const local = this.local;
    const peer = this.peerPublicRaw;
    if (!local || !peer) return "";
    const [lowKey, highKey] = compareBytes(local.publicRaw, peer) < 0 ? [local.publicRaw, peer] : [peer, local.publicRaw];
    const fingerprintLocal = encoder.encode(dtlsLocal);
    const fingerprintRemote = encoder.encode(dtlsRemote);
    const ordered =
      dtlsLocal <= dtlsRemote
        ? [fingerprintLocal, fingerprintRemote]
        : [fingerprintRemote, fingerprintLocal];
    const material = concatBytes(encoder.encode(SAS_LABEL), lowKey, highKey, ...ordered);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", material));
    const shortCode = [digest[0], digest[1], digest[2]].map((byte) => byte.toString(16).toUpperCase().padStart(2, "0"));
    return shortCode.join("-");
  }

  /** 加密一条消息；返回可直接写入 data channel 的 ArrayBuffer */
  async seal(payload: string | ArrayBuffer): Promise<ArrayBuffer> {
    if (!this.ready || !this.sendKey) throw new Error("E2EE session is not ready");
    const isText = typeof payload === "string";
    const body = isText ? encoder.encode(payload) : new Uint8Array(payload);
    if (this.sendCounter >= MAX_COUNTER) throw new Error("E2EE counter exhausted");
    const counter = this.sendCounter++;
    const nonce = buildNonce(counter);
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: TAG_BITS }, this.sendKey, body);
    const packet = new Uint8Array(HEADER_SIZE + ciphertext.byteLength);
    packet[0] = MAGIC_BYTE;
    packet[1] = isText ? FLAG_TEXT : 0x00;
    packet.set(counterToBytes(counter), 2);
    packet.set(new Uint8Array(ciphertext), HEADER_SIZE);
    return packet.buffer;
  }

  /** 判断一段 ArrayBuffer 是否是本协议封包 */
  static isSealedPacket(data: ArrayBuffer): boolean {
    return data.byteLength >= HEADER_SIZE + 16 && new Uint8Array(data, 0, 1)[0] === MAGIC_BYTE;
  }

  /**
   * 解密一条封包。
   * 返回 null 表示该数据不是 E2EE 封包（可能是握手前的明文或旧版本对端），交由调用方按原格式处理。
   */
  async open(packet: ArrayBuffer): Promise<{ data: string | ArrayBuffer; isText: boolean } | null> {
    if (!E2EESession.isSealedPacket(packet)) return null;
    if (!this.ready || !this.receiveKey) throw new Error("E2EE session is not ready");
    const view = new DataView(packet);
    const flags = view.getUint8(1);
    const counter = bytesToCounter(view, 2);
    if (counter < this.receiveCounter) throw new Error("E2EE replay detected");
    const nonce = buildNonce(counter);
    const ciphertext = packet.slice(HEADER_SIZE);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, tagLength: TAG_BITS },
      this.receiveKey,
      ciphertext,
    );
    this.receiveCounter = counter + 1;
    const isText = (flags & FLAG_TEXT) !== 0;
    return { data: isText ? decoder.decode(plaintext) : plaintext, isText };
  }

  reset(): void {
    this.state = "idle";
    this.local = null;
    this.peerPublicRaw = null;
    this.sendKey = null;
    this.receiveKey = null;
    this.sendCounter = 0;
    this.receiveCounter = 0;
    this.sas = null;
    this.notify();
  }
}
