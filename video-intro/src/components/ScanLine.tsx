import React from "react";
import { useCurrentFrame } from "remotion";

/** CRT 扫描线 — 全屏覆盖层，营造科技感 */
export const ScanLine: React.FC<{ opacity?: number }> = ({ opacity = 0.04 }) => {
  const frame = useCurrentFrame();
  const yOffset = (frame * 0.5) % 4;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 9999,
        opacity,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `repeating-linear-gradient(
            0deg,
            transparent,
            transparent ${yOffset + 2}px,
            rgba(0, 0, 0, 0.5) ${yOffset + 2}px,
            rgba(0, 0, 0, 0.5) ${yOffset + 3}px
          )`,
        }}
      />
      <div
        style={{
          position: "absolute",
          top: 0, left: 0, right: 0,
          height: "20%",
          background: "linear-gradient(to bottom, rgba(0,0,0,0.3) 0%, transparent 100%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          bottom: 0, left: 0, right: 0,
          height: "20%",
          background: "linear-gradient(to top, rgba(0,0,0,0.3) 0%, transparent 100%)",
        }}
      />
    </div>
  );
};
