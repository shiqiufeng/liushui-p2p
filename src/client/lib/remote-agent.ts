/**
 * 被控端本地代理桥接。
 *
 * 浏览器无法向系统注入输入，所以被控端需要运行 liushui-agent（见仓库 agent/ 目录）。
 * 代理启动时会打开带 `agentPort` / `agentToken` 参数的页面，本模块据此建立
 * ws://127.0.0.1:<port>/control 连接，把网页收到的控制指令转成本机输入。
 */

import type { RemoteInputCommand } from "./webrtc";

export type RemoteAgentInfo = {
  platform: string;
};

const PARAM_PORT = "agentPort";
const PARAM_TOKEN = "agentToken";
const STORAGE_KEY = "liushui-agent-binding";

type AgentBinding = { port: number; token: string };

/** 从当前 URL 读取代理参数；读不到则回退到本标签页之前保存的绑定 */
export function readAgentBinding(): AgentBinding | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const rawPort = params.get(PARAM_PORT);
  const rawToken = params.get(PARAM_TOKEN);
  if (rawPort && rawToken) {
    const port = Number(rawPort);
    if (Number.isInteger(port) && port > 0 && port < 65536) {
      const binding = { port, token: rawToken };
      try {
        window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(binding));
      } catch {
        // 隐私模式下 sessionStorage 可能不可用，忽略
      }
      return binding;
    }
  }
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as Partial<AgentBinding>;
    if (typeof parsed.port === "number" && typeof parsed.token === "string" && parsed.token) {
      return { port: parsed.port, token: parsed.token };
    }
  } catch {
    // 解析失败视为没有绑定
  }
  return null;
}

/** 从地址栏清掉令牌，避免被截图或分享链接带出去 */
export function stripAgentParams(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has(PARAM_PORT) && !url.searchParams.has(PARAM_TOKEN)) return;
  url.searchParams.delete(PARAM_PORT);
  url.searchParams.delete(PARAM_TOKEN);
  window.history.replaceState(window.history.state, "", url.toString());
}

export class RemoteAgentBridge {
  private socket: WebSocket | null = null;
  private info: RemoteAgentInfo | null = null;
  private queue: RemoteInputCommand[] = [];
  private disposed = false;

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  get agentInfo(): RemoteAgentInfo | null {
    return this.info;
  }

  async connect(binding: AgentBinding): Promise<RemoteAgentInfo | null> {
    if (this.connected) return this.info;
    if (this.disposed) return null;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: RemoteAgentInfo | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      let socket: WebSocket;
      try {
        socket = new WebSocket(`ws://127.0.0.1:${binding.port}/control?token=${encodeURIComponent(binding.token)}`);
      } catch {
        finish(null);
        return;
      }
      const timer = window.setTimeout(() => {
        finish(null);
        try {
          socket.close();
        } catch {
          // 已经关闭
        }
      }, 3_000);

      socket.addEventListener("open", () => {
        this.socket = socket;
        this.flush();
      });
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        try {
          const message = JSON.parse(event.data) as { type?: string; platform?: string };
          if (message.type === "ready") {
            this.info = { platform: message.platform ?? "unknown" };
            window.clearTimeout(timer);
            finish(this.info);
          }
        } catch {
          // 非法 JSON 忽略
        }
      });
      socket.addEventListener("error", () => {
        window.clearTimeout(timer);
        finish(null);
      });
      socket.addEventListener("close", () => {
        this.socket = null;
        window.clearTimeout(timer);
        finish(null);
      });
    });
  }

  send(command: RemoteInputCommand): void {
    if (!this.connected || !this.socket) {
      // 连接建立前先缓存少量指令，避免开头几个事件丢失
      if (this.queue.length < 32) this.queue.push(command);
      return;
    }
    try {
      this.socket.send(JSON.stringify(command));
    } catch {
      // 单条失败不影响后续
    }
  }

  private flush(): void {
    if (!this.connected || !this.socket) return;
    const pending = this.queue;
    this.queue = [];
    for (const command of pending) {
      try {
        this.socket.send(JSON.stringify(command));
      } catch {
        break;
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.queue = [];
    try {
      this.socket?.close();
    } catch {
      // 已关闭
    }
    this.socket = null;
  }
}
