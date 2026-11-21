import { describe, expect, it } from "vitest";
import { E2EESession, E2EE_HANDSHAKE_TYPE, extractDtlsFingerprint } from "../src/client/lib/e2ee";

const FP_A = "AA:11:22:33:44:55:66:77:88:99:00:11:22:33:44:55:66:77:88:99:00:11:22:33:44:55:66:77:88:99:00:11";
const FP_B = "BB:11:22:33:44:55:66:77:88:99:00:11:22:33:44:55:66:77:88:99:00:11:22:33:44:55:66:77:88:99:00:11";
const FP_M1 = "11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11";
const FP_M2 = "22:22:22:22:22:22:22:22:22:22:22:22:22:22:22:22:22:22:22:22:22:22:22:22:22:22:22:22:22:22:22:22";

describe("E2EE 会话", () => {
  it("正常连接：双方 SAS 一致且可双向解密", async () => {
    const alice = new E2EESession();
    const bob = new E2EESession();

    const aHello = await alice.beginHandshake();
    const bHello = await bob.beginHandshake();
    expect(aHello.type).toBe(E2EE_HANDSHAKE_TYPE);
    expect(aHello.pub).not.toBe(bHello.pub);

    await alice.acceptPeer(bHello.pub, FP_A, FP_B);
    await bob.acceptPeer(aHello.pub, FP_B, FP_A);

    expect(alice.ready).toBe(true);
    expect(bob.ready).toBe(true);
    expect(alice.status.sas).toBeTruthy();
    expect(alice.status.sas).toBe(bob.status.sas);

    const sealed = await alice.seal("你好，这是一条加密消息");
    expect(E2EESession.isSealedPacket(sealed)).toBe(true);
    const opened = await bob.open(sealed);
    expect(opened?.isText).toBe(true);
    expect(opened?.data).toBe("你好，这是一条加密消息");

    const binary = new Uint8Array([1, 2, 3, 4, 5]).buffer;
    const sealedBinary = await bob.seal(binary);
    const openedBinary = await alice.open(sealedBinary);
    expect(openedBinary?.isText).toBe(false);
    expect(new Uint8Array(openedBinary!.data as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it("中间人场景：两端算出的 SAS 必然不同", async () => {
    const alice = new E2EESession();
    const bob = new E2EESession();
    const attacker = new E2EESession();

    const aHello = await alice.beginHandshake();
    const bHello = await bob.beginHandshake();
    const mHello = await attacker.beginHandshake();

    // 攻击者分别与两端协商：A 以为对端是攻击者证书 M1，B 以为对端是 M2
    await alice.acceptPeer(mHello.pub, FP_A, FP_M1);
    await bob.acceptPeer(mHello.pub, FP_B, FP_M2);

    expect(alice.status.sas).toBeTruthy();
    expect(bob.status.sas).toBeTruthy();
    expect(alice.status.sas).not.toBe(bob.status.sas);
  });

  it("密文被篡改时解密失败", async () => {
    const alice = new E2EESession();
    const bob = new E2EESession();
    const aHello = await alice.beginHandshake();
    const bHello = await bob.beginHandshake();
    await alice.acceptPeer(bHello.pub, FP_A, FP_B);
    await bob.acceptPeer(aHello.pub, FP_B, FP_A);

    const sealed = await alice.seal("tamper me");
    const bytes = new Uint8Array(sealed);
    bytes[bytes.length - 1] ^= 0xff;
    await expect(bob.open(bytes.buffer)).rejects.toThrow();
  });

  it("重放同一封包会被拒绝", async () => {
    const alice = new E2EESession();
    const bob = new E2EESession();
    const aHello = await alice.beginHandshake();
    const bHello = await bob.beginHandshake();
    await alice.acceptPeer(bHello.pub, FP_A, FP_B);
    await bob.acceptPeer(aHello.pub, FP_B, FP_A);

    const first = await alice.seal("one");
    await bob.open(first);
    await expect(bob.open(first)).rejects.toThrow(/replay/i);
  });

  it("回显自身公钥的握手会被判为失败", async () => {
    const alice = new E2EESession();
    const hello = await alice.beginHandshake();
    await alice.acceptPeer(hello.pub, FP_A, FP_A);
    expect(alice.ready).toBe(false);
    expect(alice.status.state).toBe("failed");
  });

  it("未加密的数据不会被误判为密文", () => {
    expect(E2EESession.isSealedPacket(new TextEncoder().encode("plain json").buffer)).toBe(false);
  });

  it("能从 SDP 提取 DTLS 指纹", () => {
    const sdp = [
      "v=0",
      "o=- 1 2 IN IP4 127.0.0.1",
      "a=fingerprint:sha-256 AB:CD:EF:01",
      "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    ].join("\r\n");
    expect(extractDtlsFingerprint(sdp)).toBe("AB:CD:EF:01");
    expect(extractDtlsFingerprint("")).toBe("");
    expect(extractDtlsFingerprint(null)).toBe("");
  });
});
