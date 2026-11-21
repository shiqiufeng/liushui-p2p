//go:build windows

package main

// Windows 输入注入：通过 user32!SendInput 发送绝对坐标鼠标事件与键盘事件。

import (
	"errors"
	"math"
	"syscall"
	"unsafe"
)

const (
	inputMouse    = 0
	inputKeyboard = 1

	mouseMove        = 0x0001
	mouseLeftDown    = 0x0002
	mouseLeftUp      = 0x0004
	mouseRightDown   = 0x0008
	mouseRightUp     = 0x0010
	mouseMiddleDown  = 0x0020
	mouseMiddleUp    = 0x0040
	mouseWheel       = 0x0800
	mouseHorizontal  = 0x1000
	mouseVirtualDesk = 0x4000
	mouseAbsolute    = 0x8000

	keyEventUp = 0x0002

	smCxScreen = 0
	smCyScreen = 1
)

var (
	user32               = syscall.NewLazyDLL("user32.dll")
	procSendInput        = user32.NewProc("SendInput")
	procGetSystemMetrics = user32.NewProc("GetSystemMetrics")
)

type mouseInput struct {
	Dx        int32
	Dy        int32
	MouseData uint32
	Flags     uint32
	Time      uint32
	ExtraInfo uintptr
}

type keyboardInput struct {
	Vk        uint16
	Scan      uint16
	Flags     uint32
	Time      uint32
	ExtraInfo uintptr
}

// INPUT 在 x64 下为 40 字节：type(4) + padding(4) + union(32)
type inputRecord struct {
	Type  uint32
	_     uint32
	Union [32]byte
}

func sendInputRecord(record *inputRecord) error {
	count, _, err := procSendInput.Call(1, uintptr(unsafe.Pointer(record)), unsafe.Sizeof(*record))
	if count == 0 {
		if err != nil {
			return err
		}
		return errors.New("SendInput failed")
	}
	return nil
}

// screenSize 返回主显示器逻辑像素尺寸。
func screenSize() (int, int) {
	width, _, _ := procGetSystemMetrics.Call(smCxScreen)
	height, _, _ := procGetSystemMetrics.Call(smCyScreen)
	return int(width), int(height)
}

func pointerSupported() bool { return true }

// movePointer 接收 0..1 的归一化坐标，映射到虚拟桌面的绝对坐标系。
func movePointer(nx, ny float64) error {
	nx = math.Max(0, math.Min(1, nx))
	ny = math.Max(0, math.Min(1, ny))
	record := inputRecord{Type: inputMouse}
	mouse := (*mouseInput)(unsafe.Pointer(&record.Union[0]))
	mouse.Dx = int32(math.Round(nx * 65535))
	mouse.Dy = int32(math.Round(ny * 65535))
	mouse.Flags = mouseMove | mouseAbsolute | mouseVirtualDesk
	return sendInputRecord(&record)
}

// buttonFlags 把按钮名映射到按下/抬起的标志位。
func buttonFlags(button string, down bool) (uint32, bool) {
	switch button {
	case "left", "":
		if down {
			return mouseLeftDown, true
		}
		return mouseLeftUp, true
	case "right":
		if down {
			return mouseRightDown, true
		}
		return mouseRightUp, true
	case "middle":
		if down {
			return mouseMiddleDown, true
		}
		return mouseMiddleUp, true
	}
	return 0, false
}

// pressPointer 在归一化坐标处按下或抬起指定按钮。
func pressPointer(nx, ny float64, button string, down bool) error {
	flags, ok := buttonFlags(button, down)
	if !ok {
		return errors.New("unsupported mouse button")
	}
	nx = math.Max(0, math.Min(1, nx))
	ny = math.Max(0, math.Min(1, ny))
	record := inputRecord{Type: inputMouse}
	mouse := (*mouseInput)(unsafe.Pointer(&record.Union[0]))
	mouse.Dx = int32(math.Round(nx * 65535))
	mouse.Dy = int32(math.Round(ny * 65535))
	mouse.Flags = flags | mouseAbsolute | mouseVirtualDesk
	return sendInputRecord(&record)
}

// scrollPointer 发送滚轮事件；delta 为正表示向上滚动。
func scrollPointer(delta int32, horizontal bool) error {
	flag := uint32(mouseWheel)
	if horizontal {
		flag = mouseHorizontal
	}
	record := inputRecord{Type: inputMouse}
	mouse := (*mouseInput)(unsafe.Pointer(&record.Union[0]))
	mouse.MouseData = uint32(delta)
	mouse.Flags = flag
	return sendInputRecord(&record)
}

// pressKey 按虚拟键码发送按下或抬起事件。
func pressKey(vk int, down bool) error {
	if vk <= 0 || vk > 0xff {
		return errors.New("invalid virtual key")
	}
	record := inputRecord{Type: inputKeyboard}
	keyboard := (*keyboardInput)(unsafe.Pointer(&record.Union[0]))
	keyboard.Vk = uint16(vk)
	if !down {
		keyboard.Flags = keyEventUp
	}
	return sendInputRecord(&record)
}
