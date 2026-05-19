import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";

/**
 * 轨道粒子环 — 椭圆轨道上运行的光点
 * 多环可堆叠，3D perspective 透视
 */
export const OrbitalRing: React.FC<{
  size?: number;          // 环直径 (px)
  tilt?: number;          // rotateX 角度
  color?: string;
  particleCount?: number;
  ringOpacity?: number;
}> = ({
  size = 600,
  tilt = 60,
  color = "#a855f7",
  particleCount = 8,
  ringOpacity = 0.15,
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();

  const particles = Array.from({ length: particleCount }, (_, i) => ({
    angle: (i / particleCount) * Math.PI * 2,
    speed: 0.01 + i * 0.002,
    size: 2 + (i % 3),
  }));

  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        top: "50%",
        width: size,
        height: size * 0.4,
        transform: `translate(-50%, -50%) rotateX(${tilt}deg)`,
        pointerEvents: "none",
        zIndex: 3,
      }}
    >
      {/* 轨道环线 */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "50%",
          border: `2px solid ${color}`,
          opacity: ringOpacity,
          boxShadow: `0 0 20px ${color}33, inset 0 0 20px ${color}11`,
        }}
      />

      {/* 轨道光点 */}
      {particles.map((p, i) => {
        const angle = p.angle + frame * p.speed;
        const px = Math.cos(angle) * (size / 2);
        const py = Math.sin(angle) * (size * 0.2);
        const glow = Math.sin(frame * 0.06 + i) * 0.4 + 0.6;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              width: p.size * 3,
              height: p.size * 3,
              borderRadius: "50%",
              background: color,
              transform: `translate(${px - p.size * 1.5}px, ${py - p.size * 1.5}px)`,
              boxShadow: `0 0 ${p.size * 6 * glow}px ${color}, 0 0 ${p.size * 12 * glow}px ${color}66`,
              opacity: glow,
            }}
          />
        );
      })}

      {/* 中心光核 */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: 20,
          height: 20,
          transform: "translate(-50%, -50%)",
          borderRadius: "50%",
          background: `radial-gradient(circle, ${color}66, transparent)`,
          boxShadow: `0 0 40px ${color}44, 0 0 80px ${color}22`,
        }}
      />
    </div>
  );
};
