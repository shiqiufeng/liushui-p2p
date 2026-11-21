package main

// 被控端本地面板
//
// 只监听 127.0.0.1，用一次性令牌校验；页面本身不含任何外部脚本，
// 立绘从站点静态资源加载（离线时自动降级为纯色占位）。

import (
	"html/template"
	"net/http"
	"runtime"
	"strings"
)

type panelData struct {
	Host     string
	Port     int
	Token    string
	Masked   string
	Platform string
	Width    int
	Height   int
}

const panelHTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>流水P2P · 被控端</title>
<style>
  :root {
    --deep: #04070d;
    --mid: #0e2a3d;
    --accent: #67d5ff;
    --text: #e8f4ff;
    --muted: #7f97ab;
    --line: rgb(255 255 255 / 0.1);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font-family: "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif;
    color: var(--text);
    background:
      radial-gradient(120% 80% at 82% 0%, rgba(103, 213, 255, 0.16), transparent 58%),
      radial-gradient(90% 70% at 8% 100%, rgba(14, 42, 61, 0.9), transparent 62%),
      var(--deep);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 28px 20px;
    overflow: hidden;
  }
  .scene {
    position: fixed;
    inset: 0;
    background-image: url("{{.Host}}/art/night-desk.webp");
    background-size: cover;
    background-position: center;
    opacity: 0.26;
    filter: saturate(0.85);
    mask-image: radial-gradient(ellipse 90% 80% at 50% 45%, transparent 12%, #000 78%);
    -webkit-mask-image: radial-gradient(ellipse 90% 80% at 50% 45%, transparent 12%, #000 78%);
    pointer-events: none;
  }
  body::after {
    content: "";
    position: fixed;
    inset: 0;
    background: linear-gradient(180deg, rgba(4,7,13,0.55), rgba(4,7,13,0.82));
    pointer-events: none;
  }
  body::before {
    content: "";
    position: fixed;
    inset: 0;
    background-image:
      linear-gradient(to right, rgba(255,255,255,0.03) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(255,255,255,0.03) 1px, transparent 1px);
    background-size: 68px 68px;
    mask-image: radial-gradient(ellipse 80% 60% at 50% 40%, #000 10%, transparent 78%);
    pointer-events: none;
  }
  .card {
    position: relative;
    z-index: 1;
    width: min(720px, 100%);
    display: grid;
    grid-template-columns: 236px 1fr;
    gap: 26px;
    align-items: center;
    padding: 26px 28px;
    border: 1px solid var(--line);
    border-radius: 22px;
    background: linear-gradient(160deg, rgba(12, 22, 34, 0.9), rgba(6, 10, 16, 0.86));
    box-shadow: 0 40px 90px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.07);
    backdrop-filter: blur(22px) saturate(140%);
  }
  .card::after {
    content: "";
    position: absolute;
    inset: -1px;
    border-radius: 22px;
    padding: 1px;
    background: linear-gradient(140deg, rgba(103,213,255,0.5), transparent 38%, transparent 62%, rgba(103,213,255,0.24));
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    -webkit-mask-composite: xor;
    mask-composite: exclude;
    pointer-events: none;
  }
  .art { position: relative; display: flex; align-items: flex-end; justify-content: center; }
  .art::before {
    content: "";
    position: absolute;
    inset: 12% 6% 8%;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(103, 213, 255, 0.34), transparent 66%);
    filter: blur(26px);
  }
  .art img { position: relative; width: 100%; height: auto; filter: drop-shadow(0 18px 28px rgba(0, 0, 0, 0.55)); }
  .art .fallback {
    position: relative;
    width: 100%;
    aspect-ratio: 2 / 3;
    border-radius: 16px;
    border: 1px dashed rgba(255,255,255,0.16);
    display: none;
    align-items: center;
    justify-content: center;
    color: var(--muted);
    font-size: 12px;
    letter-spacing: 0.14em;
  }
  .art.offline img { display: none; }
  .art.offline .fallback { display: flex; }
  h1 { margin: 0 0 6px; font-size: 21px; letter-spacing: 0.01em; }
  .sub { margin: 0 0 18px; color: var(--muted); font-size: 13px; line-height: 1.7; }
  .sub b { color: var(--accent); font-weight: 600; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 18px; }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 11px;
    border: 1px solid var(--line);
    border-radius: 999px;
    font-size: 12px;
    color: #cfe6f6;
    background: rgba(255, 255, 255, 0.035);
  }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: #4ade80; box-shadow: 0 0 10px #4ade80; }
  .row { display: flex; gap: 10px; }
  input {
    flex: 1;
    min-width: 0;
    padding: 12px 14px;
    border-radius: 12px;
    border: 1px solid var(--line);
    background: rgba(0, 0, 0, 0.34);
    color: var(--text);
    font-size: 15px;
    letter-spacing: 0.3em;
    outline: none;
    transition: border-color .18s, box-shadow .18s;
  }
  input::placeholder { color: #4d6273; letter-spacing: 0.06em; }
  input:focus { border-color: rgba(103,213,255,0.66); box-shadow: 0 0 0 3px rgba(103,213,255,0.14); }
  button {
    padding: 12px 20px;
    border: 0;
    border-radius: 12px;
    background: linear-gradient(180deg, #7ee0ff, #37b6e6);
    color: #04121b;
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
    transition: transform .16s, box-shadow .16s, filter .16s;
    box-shadow: 0 10px 26px rgba(55, 182, 230, 0.28);
  }
  button:hover { transform: translateY(-1px); filter: brightness(1.05); }
  button:active { transform: translateY(0); }
  button.ghost {
    background: rgba(255,255,255,0.05);
    color: #cfe6f6;
    border: 1px solid var(--line);
    box-shadow: none;
    font-weight: 600;
  }
  .hint { margin-top: 14px; font-size: 12px; color: var(--muted); line-height: 1.7; }
  .token {
    margin-top: 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    color: #93b3c7;
    word-break: break-all;
    padding: 9px 11px;
    border-radius: 10px;
    background: rgba(0,0,0,0.32);
    border: 1px solid rgba(255,255,255,0.06);
  }
  @media (max-width: 640px) {
    .card { grid-template-columns: 1fr; gap: 16px; padding: 20px; }
    .art { max-width: 168px; margin: 0 auto; }
  }
</style>
</head>
<body>
  <div class="scene"></div>
  <main class="card">
    <div class="art" id="art">
      <img id="mascot" alt="" src="{{.Host}}/art/mascot.webp" />
      <div class="fallback">被控端</div>
    </div>
    <section>
      <h1>流水P2P 被控端</h1>
      <p class="sub">本机代理已就绪，等待网页端的控制请求。<br />只有你手动点击 <b>允许并共享屏幕</b>，对方才能操作这台电脑。</p>
      <div class="chips">
        <span class="chip"><i class="dot"></i>在线</span>
        <span class="chip">{{.Platform}}</span>
        <span class="chip">{{.Width}} × {{.Height}}</span>
        <span class="chip">127.0.0.1:{{.Port}}</span>
      </div>
      <div class="row">
        <input id="room" inputmode="numeric" maxlength="8" placeholder="输入房间号，例如 1111" />
        <button id="go">进入房间</button>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="ghost" id="copy" style="flex:1">复制控制令牌</button>
        <button class="ghost" id="plain" style="flex:1">不带房间打开</button>
      </div>
      <div class="hint">令牌只对本次运行有效。关闭本窗口或结束进程即失效。</div>
      <div class="token" id="token">{{.Masked}}</div>
    </section>
  </main>
  <script>
    const HOST = {{.Host}};
    const PORT = {{.Port}};
    const TOKEN = {{.Token}};
    const art = document.getElementById('art');
    document.getElementById('mascot').addEventListener('error', () => art.classList.add('offline'));
    const open = (room) => {
      const base = HOST + '/zh';
      const url = (room ? base + '/room/' + room : base) + '?agentPort=' + PORT + '&agentToken=' + encodeURIComponent(TOKEN);
      window.location.href = url;
    };
    document.getElementById('go').addEventListener('click', () => {
      const room = document.getElementById('room').value.replace(/\D/g, '');
      if (!room) { document.getElementById('room').focus(); return; }
      open(room);
    });
    document.getElementById('room').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('go').click();
    });
    document.getElementById('plain').addEventListener('click', () => open(''));
    document.getElementById('copy').addEventListener('click', async (e) => {
      try { await navigator.clipboard.writeText(TOKEN); e.target.textContent = '已复制'; }
      catch { e.target.textContent = '请手动复制'; }
      setTimeout(() => { e.target.textContent = '复制控制令牌'; }, 1600);
    });
  </script>
</body>
</html>`

var panelTemplate = template.Must(template.New("panel").Parse(panelHTML))

func servePanel(host string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		width, height := screenSize()
		data := panelData{
			Host:     host,
			Port:     agentPort,
			Token:    agentToken,
			Masked:   maskToken(agentToken),
			Platform: platformLabel(),
			Width:    width,
			Height:   height,
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_ = panelTemplate.Execute(w, data)
	}
}

func platformLabel() string {
	switch runtime.GOOS {
	case "windows":
		return "Windows"
	case "darwin":
		return "macOS"
	default:
		return strings.ToUpper(runtime.GOOS[:1]) + runtime.GOOS[1:]
	}
}

// maskToken 只展示首尾，避免肩窥时整串泄露。
func maskToken(token string) string {
	if len(token) <= 12 {
		return token
	}
	return token[:6] + "····" + token[len(token)-6:]
}
