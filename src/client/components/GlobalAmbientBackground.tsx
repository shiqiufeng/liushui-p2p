import { type CSSProperties } from "react";
import { useTheme } from "@/components/theme";

/**
 * 极简环境光背景。
 *
 * 设计取舍：
 * - 弃用 WebGL 流体（GPU 常驻渲染、色彩噪声大、文字对比度不稳）
 * - 改为纯 CSS 分层：底色渐变 + 两团缓慢漂移的柔光 + 细网格 + 胶片颗粒 + 暗角
 * - 全部颜色来自主题令牌，切换主题时整屏质感跟着变，无需重绘 canvas
 * - 静态层不参与动画合成，只有两团柔光做 transform 漂移，移动端也能跑满帧
 */
export function GlobalAmbientBackground() {
  const { theme } = useTheme();

  return (
    <div
      aria-hidden="true"
      className="liushui-ambient pointer-events-none fixed inset-0 z-0 overflow-hidden"
      style={
        {
          "--ambient-deep": theme.deep,
          "--ambient-mid": theme.mid,
          "--ambient-accent": theme.accent,
          "--ambient-highlight": theme.highlight,
        } as CSSProperties
      }
    >
      <div className="liushui-ambient-base" />
      <div className="liushui-ambient-glow liushui-ambient-glow--a" />
      <div className="liushui-ambient-glow liushui-ambient-glow--b" />
      <div className="liushui-ambient-grid" />
      <div className="liushui-ambient-grain" />
      <div className="liushui-ambient-vignette" />
      <div className="liushui-ambient-hairline" />
    </div>
  );
}
