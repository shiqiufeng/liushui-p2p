import { useState } from "react";

/**
 * 首页角落的二次元向导。
 *
 * 只做三件事：露个脸、说一句有用的话、能被关掉。
 * 立绘走 public/art/mascot.webp（透明底），关掉后本机会话内不再出现。
 */
export function HomeMascot({ locale }: { locale: "zh" | "en" }) {
  const [dismissed, setDismissed] = useState(false);
  const [hovered, setHovered] = useState(false);

  if (dismissed) return null;

  const line =
    locale === "zh"
      ? "输入同一个六位数字就能进来，人数上限创建时自己选。"
      : "Share the same 6 digits to join — the creator picks the seat limit.";

  return (
    <div
      className="liushui-mascot"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className={`liushui-mascot-bubble ${hovered ? "is-hovered" : ""}`}>
        <button
          aria-label={locale === "zh" ? "关闭提示" : "Dismiss"}
          className="liushui-mascot-close"
          onClick={() => setDismissed(true)}
          type="button"
        >
          ×
        </button>
        <p>{line}</p>
        <span className="liushui-mascot-name">
          {locale === "zh" ? "流水 · 向导" : "Liushui · Guide"}
        </span>
      </div>
      <img alt="" aria-hidden="true" className="liushui-mascot-art" src="/art/mascot.webp" />
    </div>
  );
}
