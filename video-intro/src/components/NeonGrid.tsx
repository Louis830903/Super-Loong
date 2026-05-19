import React from "react";
import { useCurrentFrame } from "remotion";

/**
 * 霓虹透视网格 — 3D 地平面网格线
 * 纯 CSS 实现，零 DOM 开销。始终在 zIndex:0 背景层
 */
export const NeonGrid: React.FC<{
  color?: string;
  opacity?: number;
  pulseSpeed?: number;
}> = ({ color = "#a855f7", opacity = 0.12, pulseSpeed = 0.03 }) => {
  const frame = useCurrentFrame();
  const pulse = Math.sin(frame * pulseSpeed) * 0.3 + 0.7;

  // 安全计算 hex alpha，防止 Math.round 溢出 255
  const alphaHex = (raw: number) =>
    Math.min(255, Math.round(raw * 255))
      .toString(16)
      .padStart(2, "0");

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 0,
        pointerEvents: "none",
        overflow: "hidden",
      }}
    >
      {/* 透视网格 — 使用 transform 模拟 3D 地面 */}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: "50%",
          width: "200%",
          height: "70%",
          transform: "translateX(-50%) perspective(600px) rotateX(60deg)",
          transformOrigin: "bottom center",
          background: `
            repeating-linear-gradient(
              90deg,
              ${color}${alphaHex(pulse * opacity)} 0px,
              transparent 1px,
              transparent 80px
            ),
            repeating-linear-gradient(
              0deg,
              ${color}${alphaHex(pulse * opacity)} 0px,
              transparent 1px,
              transparent 80px
            )
          `,
        }}
      />
      {/* 地平线发光 */}
      <div
        style={{
          position: "absolute",
          bottom: "25%",
          left: 0,
          right: 0,
          height: 3,
          background: `linear-gradient(90deg, transparent, ${color}${alphaHex(pulse * 0.6)}, transparent)`,
          boxShadow: `0 0 ${40 * pulse}px ${color}44`,
          zIndex: 0,
        }}
      />
    </div>
  );
};
