package main

// 流水P2P 远程控制 · 被控端代理
//
// 浏览器受沙箱限制无法向操作系统注入输入，所以「控制别人电脑」需要被控端
// 跑一个本地小程序：网页负责 WebRTC 传输与屏幕采集，本程序只负责把收到的
// 鼠标/键盘事件转换成本机输入事件。
//
// 启动后会自动打开浏览器并携带一次性令牌，网页通过 ws://127.0.0.1:<port>
// 与本程序建立连接。令牌保证同一台机器上其他网页无法劫持控制通道。

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"
)

type command struct {
	Type   string  `json:"type"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Button string  `json:"button"`
	Down   bool    `json:"down"`
	Vk     int     `json:"vk"`
	Delta  int32   `json:"delta"`
}

var (
	agentToken string
	agentPort  int
	activeConn sync.Mutex
)

func randomToken() string {
	buffer := make([]byte, 24)
	if _, err := rand.Read(buffer); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buffer)
}

func applyCommand(item command) error {
	switch item.Type {
	case "move":
		return movePointer(item.X, item.Y)
	case "button":
		return pressPointer(item.X, item.Y, item.Button, item.Down)
	case "wheel":
		return scrollPointer(item.Delta, false)
	case "hwheel":
		return scrollPointer(item.Delta, true)
	case "key":
		return pressKey(item.Vk, item.Down)
	default:
		return nil
	}
}

func handleControl(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("token") != agentToken {
		http.Error(w, "invalid token", http.StatusForbidden)
		return
	}
	if !pointerSupported() {
		http.Error(w, "input injection is not supported on this platform", http.StatusNotImplemented)
		return
	}
	conn, err := upgradeWebSocket(w, r)
	if err != nil {
		log.Printf("websocket upgrade failed: %v", err)
		return
	}
	defer conn.Close()

	// 同一时刻只允许一个控制通道，避免多个标签页争夺输入
	if !activeConn.TryLock() {
		_ = conn.WriteMessage([]byte(`{"type":"error","message":"another control session is active"}`))
		return
	}
	defer activeConn.Unlock()

	log.Printf("控制通道已连接：%s", r.RemoteAddr)
	_ = conn.WriteMessage([]byte(`{"type":"ready","platform":"` + runtime.GOOS + `"}`))

	for {
		payload, err := conn.ReadMessage()
		if err != nil {
			log.Printf("控制通道断开：%v", err)
			return
		}
		var item command
		if err := json.Unmarshal(payload, &item); err != nil {
			continue
		}
		if err := applyCommand(item); err != nil {
			log.Printf("输入注入失败（%s）：%v", item.Type, err)
		}
	}
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		log.Printf("无法自动打开浏览器，请手动访问：%s", url)
	}
}

func main() {
	port := flag.Int("port", 17877, "本地监听端口")
	room := flag.String("room", "", "直接进入的四位房间号（可留空）")
	host := flag.String("host", "https://p2p.liushuile.dpdns.org", "站点地址")
	noBrowser := flag.Bool("no-browser", false, "不自动打开浏览器")
	flag.Parse()

	agentToken = randomToken()
	agentPort = *port
	width, height := screenSize()
	log.Printf("流水P2P 被控端已启动 | 屏幕 %dx%d | 平台 %s", width, height, runtime.GOOS)

	mux := http.NewServeMux()
	mux.HandleFunc("/ping", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"ok":true,"platform":%q,"width":%d,"height":%d}`, runtime.GOOS, width, height)
	})
	mux.HandleFunc("/control", handleControl)
	mux.Handle("/", servePanel(strings.TrimRight(*host, "/")))

	address := fmt.Sprintf("127.0.0.1:%d", *port)
	listener, err := net.Listen("tcp", address)
	if err != nil {
		log.Fatalf("端口 %d 已被占用：%v", *port, err)
	}

	base := strings.TrimRight(*host, "/") + "/zh"
	target := base + fmt.Sprintf("?agentPort=%d&agentToken=%s", *port, agentToken)
	if *room != "" {
		target = base + "/room/" + *room + fmt.Sprintf("?agentPort=%d&agentToken=%s", *port, agentToken)
	}
	panel := fmt.Sprintf("http://127.0.0.1:%d/", *port)
	log.Printf("控制面板：%s", panel)
	log.Printf("直达房间：%s", target)
	log.Printf("令牌：%s（仅本次运行有效）", agentToken)

	if !*noBrowser {
		go func() {
			time.Sleep(300 * time.Millisecond)
			if *room == "" {
				openBrowser(panel)
			} else {
				openBrowser(target)
			}
		}()
	}

	if err := http.Serve(listener, mux); err != nil {
		log.Fatalf("本地服务退出：%v", err)
	}
}
