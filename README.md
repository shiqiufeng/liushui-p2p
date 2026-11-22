# 流水P2P

流水P2P 是一个开源的 WebRTC 点对点连接网页工具，可自行部署在 Cloudflare 上。

支持端对端加密的匿名实时聊天、文件互传、语音通话、视频通话、屏幕共享、同播共享、文本协作、画板等功能，支持点对点直连或 Cloudflare TURN 中转。

无任何账号 / 数据记录机制、完全匿名，两位参与者输入相同的四位房间号后即可连接。直接使用 Cloudflare 部署，即可建立点对点直连连接。配置 Cloudflare TURN 服务器后，可每月免费获得 1000GB 中转连接流量。

延续并改进了 [RavelloH/TimePulse](https://github.com/RavelloH/TimePulse) 的玻璃态设计美学。

本仓库基于 [RavelloH/ZestSend](https://github.com/RavelloH/ZestSend) 修改并更名，遵循 MIT 许可证，原作者署名保留。

## 房间

只有一种房间：双人房 `/zh/room/123456`，两个人、一条 `RTCPeerConnection`，六个固定媒体槽位（屏幕 / 摄像头 / 麦克风 / 语音等）。

- 房间号是六位数字，两端输入同一个号即连上；谁先进入谁创建，不需要提前占号。
- 文件传输、共享画板、同步播放、远程控制、文字聊天全部可用。
- 首页底部「创建双人房 · 随机号码」会直接生成一个六位号进入。

## 外观

- 背景为照片环境光：底图取自相册照片（内置 4 张，已压成 1920 宽 WebP，单张 < 100 KB），新开标签页随机一张、同标签页刷新不变；照片之上叠多层 scrim 压暗，上半屏隐约透出、下半屏回到主题深色，再叠低频柔光 + 细网格 + 胶片颗粒 + 暗角，切换配色时色调整屏跟着变。不再使用 WebGL 流体，省掉 canvas 常驻渲染。
- 想换成自己的照片：把图片导出为 1920 宽的 WebP 放进 `public/art/`（命名 `photo-*.webp`），再改 `src/client/components/GlobalAmbientBackground.tsx` 里的 `PHOTO_BACKDROPS` 数组即可，`position` 控制构图焦点、`opacity` 控制该张的存在感。
- 十一种配色内含「樱线」粉紫主题。
- 首页左下角有二次元向导立绘（可关闭），被控端面板同样使用这套立绘。

## 部署

Fork 本仓库后，在 Cloudflare Dashboard 的 **Workers & Pages** 中依次选择 **Create application** → **Import a repository**，选择自己的 Fork 并完成 GitHub 授权。

在部署设置中保留 Worker 名称为 `liushui-p2p`（需与 `wrangler.jsonc` 一致），选择 `main` 作为生产分支，并设置：

| 配置 | 值 |
| --- | --- |
| Package manager | `pnpm` |
| Build command | 留空 |
| Deploy command | `pnpm deploy` |

### 可选：配置 TURN 中继

没有 TURN 时，两端都处于运营商 NAT（CGNAT）后面就会连不上——界面上表现为「TURN 服务器 / 无可用 TURN 服务器，仅可建立直连」加「直连失败」。公共免费 TURN 目前基本不可用（实测 openrelay、freestun 都拿不到 relay 候选），所以中继必须自己配。

`POST /api/turn/credentials` 会自动识别下面任意一组配置，配好哪组用哪组，优先级从上到下：

| 方式 | 需要设置的变量 | 说明 |
| --- | --- | --- |
| Cloudflare TURN（推荐） | `TURN_ID` + `TURN_TOKEN` | Dashboard → **Realtime** → **TURN** → **Create TURN App**，免费 1000GB/月 |
| Metered TURN | `METERED_DOMAIN` + `METERED_API_KEY` | 形如 `xxxx.metered.live`，免费 500MB/月 |
| 自建 coturn | `TURN_URLS` + `TURN_USERNAME` + `TURN_CREDENTIAL` | `TURN_URLS` 逗号分隔，支持 `turn:` / `turns:` |

用 `wrangler secret put` 写入即可，secret 变更会自动发布新版本，不必重新构建：

```bash
wrangler secret put TURN_ID
wrangler secret put TURN_TOKEN
```

写入后用 `GET /api/turn/status` 确认，返回 `{"configured":true,"provider":"cloudflare"}` 即生效：

```bash
curl https://<你的域名>/api/turn/status
```

后续更新时，在 GitHub 通过 **Sync fork** 拉取上游提交并合并到 `main`；Cloudflare 会自动构建并部署。

## 预览

前往 https://p2p.liushuile.dpdns.org 查看效果。

### 绑定自定义域（Fork 后必改）

`wrangler.jsonc` 里的 `routes` 已经指向本项目的域名：

```jsonc
"routes": [
  { "pattern": "p2p.liushuile.dpdns.org", "custom_domain": true }
],
```

这个域名在作者的 Cloudflare 账号下才有权限，**Fork 后不改会部署失败**，二选一：

- 换成自己的域名（该域名所在的 zone 需托管在同一 Cloudflare 账号）：把 `pattern` 改成 `你的域名`，再 `pnpm deploy`，Cloudflare 会自动创建 DNS 记录并签发证书，无需手动操作。
- 不绑定：删掉整个 `routes` 字段，部署后走 `https://<worker 名>.<你的子域>.workers.dev`。

<img width="2478" height="1455" alt="image" src="https://github.com/user-attachments/assets/c842bdce-a80c-4760-947d-b601b1023b1f" />
<img width="2478" height="1455" alt="image" src="https://github.com/user-attachments/assets/578cf5c6-5ec1-4ba5-a490-a3052cc9bc25" />
<img width="2478" height="1455" alt="image" src="https://github.com/user-attachments/assets/90ba302f-a5ed-4e9a-98c0-f2fcc2f0484a" />
<img width="2478" height="1455" alt="image" src="https://github.com/user-attachments/assets/ea9522f1-e074-4d6b-8d4c-26963523d044" />
<img width="2560" height="1528" alt="image" src="https://github.com/user-attachments/assets/db5058f0-96ab-43f2-bbea-802ada0e25f1" />
<img width="2478" height="1455" alt="image" src="https://github.com/user-attachments/assets/d8524922-8792-45c1-9196-36585af365b2" />
<img width="2478" height="1455" alt="image" src="https://github.com/user-attachments/assets/d3fd6f95-285a-49be-9c59-d6ae7a63ed3e" />
<img width="2478" height="1455" alt="image" src="https://github.com/user-attachments/assets/a9c5cde1-74f1-4b72-9bdc-4c4e3a484d1b" />
<img width="2478" height="1455" alt="image" src="https://github.com/user-attachments/assets/6004e9f8-8b6e-4fee-99e8-000107e96524" />
<img width="2478" height="1455" alt="image" src="https://github.com/user-attachments/assets/5fdd10e9-b273-4c8d-a5d1-5f579ec4cd91" />
<img width="2478" height="1455" alt="image" src="https://github.com/user-attachments/assets/808932dc-671d-4dec-9a3a-8ac7e08282e0" />



## 技术栈

- Cloudflare Workers、Durable Objects、Realtime TURN
- Hono、Wrangler、Cloudflare Vite Plugin
- 原生 WebRTC 的 `RTCPeerConnection`、`RTCDataChannel`、MediaStream
- React、Vite、TypeScript、Tailwind CSS、TanStack Router
- Tiptap、Yjs
- Framer Motion

## 本地开发

```bash
pnpm install
pnpm dev
```

打开 [http://127.0.0.1:8787](http://127.0.0.1:8787)。

可选的 TURN 配置写入 `.env`（任选一种，写法同上表）：

```dotenv
TURN_ID=your_cloudflare_turn_key_id
TURN_TOKEN=your_cloudflare_turn_api_token
```

未配置 TURN 时，应用仍会使用公共 STUN 尝试直连；受限网络无法穿透时不会启用中继。

## 许可证

本项目采用 [MIT License](LICENSE)。
