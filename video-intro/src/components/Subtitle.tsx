import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";

/** 字幕条目 */
export interface SubtitleItem {
  startFrame: number;  // 起始帧 (场景内本地帧号)
  duration: number;     // 持续帧数
  zh: string;           // 中文字幕
  en: string;           // 英文翻译
}

/** 动态字幕 — 底部居中，中英双语，带弹簧淡入淡出 */
export const Subtitle: React.FC<{ items: SubtitleItem[] }> = ({ items }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  for (const item of items) {
    const relativeFrame = frame - item.startFrame;
    if (relativeFrame >= 0 && relativeFrame <= item.duration) {
      const enter = spring({
        frame: Math.min(relativeFrame, 10),
        fps,
        config: { damping: 200, stiffness: 120 },
      });
      const exit = interpolate(
        relativeFrame,
        [item.duration - 8, item.duration],
        [1, 0],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
      );
      const opacity = enter * exit;
      const translateY = interpolate(enter, [0, 1], [12, 0]);

      return (
        <div
          style={{
            position: "absolute",
            bottom: 60,
            left: 0,
            right: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 6,
            pointerEvents: "none",
            zIndex: 100,
            opacity,
            transform: `translateY(${translateY}px)`,
          }}
        >
          <span
            style={{
              fontSize: 28,
              fontWeight: 700,
              color: "#ffffff",
              textShadow: "0 0 20px rgba(168,85,247,0.5), 0 2px 8px rgba(0,0,0,0.8)",
              letterSpacing: "0.06em",
              padding: "6px 28px",
              borderRadius: 8,
              background: "rgba(10,10,20,0.6)",
              backdropFilter: "blur(8px)",
              border: "1px solid rgba(255,255,255,0.08)",
            }}
          >
            {item.zh}
          </span>
          <span
            style={{
              fontSize: 16,
              fontWeight: 400,
              color: "rgba(255,255,255,0.45)",
              letterSpacing: "0.08em",
              textShadow: "0 1px 4px rgba(0,0,0,0.6)",
            }}
          >
            {item.en}
          </span>
        </div>
      );
    }
  }

  return null;
};
