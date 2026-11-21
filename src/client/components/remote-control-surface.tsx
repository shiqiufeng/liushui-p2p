/**
 * 控制端的输入捕获层。
 *
 * 覆盖在远端屏幕画面上，把鼠标/键盘事件归一化成 0..1 坐标与虚拟键码，
 * 通过 data channel 发给被控端。被控端再由 liushui-agent 注入系统输入。
 */

import { useEffect, useRef } from "react";
import type { RemoteInputCommand } from "../lib/webrtc";

type Props = {
  active: boolean;
  onCommand: (command: RemoteInputCommand) => void;
  onExit: () => void;
};

function buttonName(button: number): string {
  if (button === 2) return "right";
  if (button === 1) return "middle";
  return "left";
}

export function RemoteControlSurface({ active, onCommand, onExit }: Props) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);
  const pendingMoveRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!active) return;
    const surface = surfaceRef.current;
    if (!surface) return;
    surface.focus();

    const toNormalized = (event: PointerEvent) => {
      const rect = surface.getBoundingClientRect();
      const x = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5;
      const y = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;
      return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
    };

    const flushMove = () => {
      frameRef.current = null;
      const position = pendingMoveRef.current;
      if (!position) return;
      pendingMoveRef.current = null;
      onCommand({ type: "move", x: position.x, y: position.y });
    };

    const handlePointerMove = (event: PointerEvent) => {
      pendingMoveRef.current = toNormalized(event);
      if (frameRef.current === null) frameRef.current = window.requestAnimationFrame(flushMove);
    };

    const handlePointerDown = (event: PointerEvent) => {
      event.preventDefault();
      const position = toNormalized(event);
      onCommand({ type: "move", x: position.x, y: position.y });
      onCommand({ type: "button", button: buttonName(event.button), down: true, x: position.x, y: position.y });
      surface.focus();
    };

    const handlePointerUp = (event: PointerEvent) => {
      event.preventDefault();
      const position = toNormalized(event);
      onCommand({ type: "button", button: buttonName(event.button), down: false, x: position.x, y: position.y });
    };

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const delta = Math.round(Math.max(-600, Math.min(600, -event.deltaY)));
      if (delta === 0) return;
      onCommand({ type: "wheel", delta });
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onExit();
        return;
      }
      event.preventDefault();
      onCommand({ type: "key", down: true, vk: event.keyCode });
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      event.preventDefault();
      onCommand({ type: "key", down: false, vk: event.keyCode });
    };

    const preventContextMenu = (event: Event) => event.preventDefault();

    surface.addEventListener("pointermove", handlePointerMove);
    surface.addEventListener("pointerdown", handlePointerDown);
    surface.addEventListener("pointerup", handlePointerUp);
    surface.addEventListener("contextmenu", preventContextMenu);
    surface.addEventListener("wheel", handleWheel, { passive: false });
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    return () => {
      surface.removeEventListener("pointermove", handlePointerMove);
      surface.removeEventListener("pointerdown", handlePointerDown);
      surface.removeEventListener("pointerup", handlePointerUp);
      surface.removeEventListener("contextmenu", preventContextMenu);
      surface.removeEventListener("wheel", handleWheel);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [active, onCommand, onExit]);

  if (!active) return null;

  return (
    <div
      aria-label="远程控制区域，按 Esc 退出"
      className="absolute inset-0 z-30 cursor-none touch-none bg-transparent outline-none"
      ref={surfaceRef}
      role="application"
      tabIndex={0}
    />
  );
}
