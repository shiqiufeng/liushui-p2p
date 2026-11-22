import { type CSSProperties, useEffect, useState } from "react";
import { useTheme } from "@/components/theme";

/**
 * 相册照片环境光背景。
 *
 * 设计取舍：
 * - 底图取自本机相册照片（已压成 WebP，1920 宽，单张 < 100 KB）
 * - 每次打开标签页随机一张，同一标签页刷新保持不变（sessionStorage）
 * - 照片只在中上部隐约透出，四周用多层 scrim 压回深色，保证正文对比度
 * - 保留极低透明度的主题柔光 + 细网格 + 胶片颗粒 + 暗角，让不同照片共用同一套质感
 * - 只有 transform 参与动画，静态层不重建合成，移动端也能跑满帧
 */

type PhotoBackdrop = {
  /** 文件路径（public/art 下） */
  src: string;
  /** 构图焦点，避免人脸/主体被裁掉 */
  position: string;
  /** 单张亮度增益：暗图给足存在感，亮图压低避免背景泛灰 */
  opacity: number;
  zh: string;
};

const PHOTO_BACKDROPS: readonly PhotoBackdrop[] = [
  { src: "/art/photo-aurora.webp", position: "50% 56%", opacity: 0.68, zh: "极光湖" },
  { src: "/art/photo-cyber.webp", position: "50% 30%", opacity: 0.6, zh: "赛博少女" },
  { src: "/art/photo-cat.webp", position: "46% 40%", opacity: 0.62, zh: "余晖" },
  { src: "/art/photo-mono.webp", position: "58% 22%", opacity: 0.34, zh: "凝眸" },
];

const PHOTO_STORAGE_KEY = "liushui-ambient-photo";

function readSavedIndex(): number | null {
  try {
    const saved = window.sessionStorage.getItem(PHOTO_STORAGE_KEY);
    if (!saved) return null;
    const index = Number.parseInt(saved, 10);
    if (!Number.isInteger(index)) return null;
    if (index < 0 || index >= PHOTO_BACKDROPS.length) return null;
    return index;
  } catch {
    return null;
  }
}

function pickBackdropIndex(): number {
  const saved = readSavedIndex();
  if (saved !== null) return saved;
  return Math.floor(Math.random() * PHOTO_BACKDROPS.length);
}

export function GlobalAmbientBackground() {
  const { theme } = useTheme();
  const [photoIndex, setPhotoIndex] = useState<number | null>(null);

  // 客户端挂载后再决定照片，避免服务端/首帧结构不一致
  useEffect(() => {
    const index = pickBackdropIndex();
    setPhotoIndex(index);
    try {
      window.sessionStorage.setItem(PHOTO_STORAGE_KEY, String(index));
    } catch {
      // 隐私模式下 sessionStorage 不可写，随机效果照常生效
    }
  }, []);

  const photo = photoIndex === null ? null : PHOTO_BACKDROPS[photoIndex];

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
      {photo ? (
        <>
          <div
            className="liushui-ambient-photo"
            style={{
              backgroundImage: `url("${photo.src}")`,
              backgroundPosition: photo.position,
              ["--ambient-photo-opacity" as string]: String(photo.opacity),
            } as CSSProperties}
          />
          <div className="liushui-ambient-photo-scrim" />
        </>
      ) : null}
      <div className="liushui-ambient-glow liushui-ambient-glow--a" />
      <div className="liushui-ambient-glow liushui-ambient-glow--b" />
      <div className="liushui-ambient-grid" />
      <div className="liushui-ambient-grain" />
      <div className="liushui-ambient-vignette" />
      <div className="liushui-ambient-hairline" />
    </div>
  );
}
