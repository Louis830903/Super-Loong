import React, { useMemo } from "react";
import { useCurrentFrame, useVideoConfig, random, interpolate } from "remotion";

const COLOR_THEMES = [
  ["#a855f7", "#22d3ee"],   // 紫-青
  ["#f97316", "#fbbf24"],   // 橙-金
  ["#34d399", "#60a5fa"],   // 绿-蓝
  ["#f472b6", "#a855f7"],   // 粉-紫
];

// 矩阵雨字符集
const MATRIX_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789あいうえおカキクケコ$#@%&*";

/** 超级粒子背景 — 支持 flow/burst/matrix 三种模式 */
export const ParticleBg: React.FC<{
  count?: number;
  intensity?: "low" | "normal" | "high";
  mode?: "flow" | "burst" | "matrix";
  zIndex?: number;
}> = ({ count = 100, intensity = "normal", mode = "flow", zIndex = 1 }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const multiplier = intensity === "high" ? 1.5 : intensity === "low" ? 0.5 : 1;

  const particles = useMemo(() => {
    const themeIdx = Math.floor(random("theme") * COLOR_THEMES.length);
    const [color1, color2] = COLOR_THEMES[themeIdx];
    const total = Math.floor(count * multiplier);

    return Array.from({ length: total }, (_, i) => ({
      size: random(`ps-${i}`) * 3 + 1,
      speed: random(`psp-${i}`) * 0.5 + 0.15,
      opacity: random(`po-${i}`) * 0.5 + 0.08,
      drift: (random(`pdr-${i}`) - 0.5) * 0.8,
      color: random(`pc-${i}`) > 0.5 ? color1 : color2,
      orbitRadius: random(`por-${i}`) * 40 + 10,
      orbitSpeed: (random(`pos-${i}`) - 0.5) * 0.04,
      // flow
      x: random(`px-${i}`) * width,
      y: random(`py-${i}`) * height,
      // burst
      baseX: width * 0.5 + (random(`pbx-${i}`) - 0.5) * 60,
      baseY: height * 0.4 + (random(`pby-${i}`) - 0.5) * 60,
      burstAngle: random(`pba-${i}`) * Math.PI * 2,
      burstSpeed: random(`pbs-${i}`) * 6 + 2,
      burstLife: random(`pbl-${i}`) * 40 + 20,
      // matrix
      col: Math.floor(random(`pcol-${i}`) * (width / 14)),
      rowDelay: random(`prd-${i}`) * 80,
      charIndex: Math.floor(random(`pci-${i}`) * MATRIX_CHARS.length),
    }));
  }, [count, width, height, multiplier]);

  const hueShift = (frame * 0.15) % 360;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        background: `radial-gradient(ellipse at 50% 50%, hsl(${260 + hueShift * 0.3}, 50%, 12%) 0%, #06060e 70%)`,
        zIndex,
      }}
    >
      {/* 大光晕 */}
      <div
        style={{
          position: "absolute",
          width: 800, height: 800,
          left: "50%", top: "50%",
          transform: `translate(-50%, -50%) rotate(${frame * 0.02}deg)`,
          borderRadius: "50%",
          background: `radial-gradient(circle, hsla(${260 + hueShift * 0.5}, 80%, 50%, 0.06) 0%, transparent 70%)`,
          pointerEvents: "none",
        }}
      />

      {/* 矩阵雨模式 */}
      {mode === "matrix" && particles.slice(0, 40).map((p, i) => {
        const localFrame = Math.max(0, frame - p.rowDelay);
        const row = (localFrame * p.speed * 0.8) % (height / 14 + 8);
        const charRotate = Math.floor(localFrame * 0.3 + i) % MATRIX_CHARS.length;
        const fadeIn = interpolate(localFrame, [0, 8], [0, 1], { extrapolateRight: "clamp" });
        const fadeOut = interpolate(row, [height / 14 - 4, height / 14 + 4], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: p.col * 14,
              top: row * 14,
              fontSize: 13,
              fontFamily: "monospace",
              color: `hsl(${140 + i * 5}, 90%, ${60 + p.opacity * 40}%)`,
              opacity: fadeIn * fadeOut * 0.7,
              textShadow: `0 0 6px hsl(${140 + i * 5}, 90%, 60%)`,
              pointerEvents: "none",
              zIndex: 1,
            }}
          >
            {MATRIX_CHARS[(p.charIndex + charRotate) % MATRIX_CHARS.length]}
          </div>
        );
      })}

      {/* burst 模式 */}
      {mode === "burst" && particles.slice(0, Math.floor(count * multiplier)).map((p, i) => {
        const burstProgress = Math.min(frame / p.burstLife, 1);
        const easeOut = 1 - Math.pow(1 - burstProgress, 3);
        const dist = easeOut * p.burstSpeed * 120;
        const bx = p.baseX + Math.cos(p.burstAngle) * dist;
        const by = p.baseY + Math.sin(p.burstAngle) * dist;
        const bFade = interpolate(burstProgress, [0, 0.15, 0.7, 1], [0, 1, 0.6, 0]);
        const pulse = Math.sin(frame * 0.06 + i * 0.3) * 0.25 + 0.75;
        return (
          <div key={i} style={{
            position: "absolute", left: bx, top: by,
            width: p.size * pulse, height: p.size * pulse,
            borderRadius: "50%", background: p.color,
            opacity: bFade * p.opacity,
            boxShadow: `0 0 ${p.size * 5}px ${p.color}, 0 0 ${p.size * 10}px ${p.color}44`,
            transform: "translate(-50%, -50%)",
          }} />
        );
      })}

      {/* flow 模式 */}
      {mode === "flow" && particles.map((p, i) => {
        const baseY = (p.y + frame * p.speed * 0.6) % height;
        const orbitX = Math.cos(frame * p.orbitSpeed + i) * p.orbitRadius;
        const orbitY = Math.sin(frame * p.orbitSpeed + i) * p.orbitRadius * 0.5;
        const px = p.x + Math.sin(frame * 0.02 + i) * p.drift * 35 + orbitX;
        const py = baseY + orbitY;
        const pulse = Math.sin(frame * 0.05 + i * 0.7) * 0.3 + 1;
        return (
          <div key={i} style={{
            position: "absolute",
            left: ((px % width) + width) % width,
            top: ((py % height) + height) % height,
            width: p.size * pulse, height: p.size * pulse,
            borderRadius: "50%", background: p.color,
            opacity: p.opacity * pulse,
            boxShadow: `0 0 ${p.size * 4}px ${p.color}, 0 0 ${p.size * 8}px ${p.color}44`,
          }} />
        );
      })}

      {/* 底部流光 */}
      <div style={{
        position: "absolute", bottom: 0, left: 0, right: 0, height: 2,
        background: `linear-gradient(90deg, transparent, hsl(${260 + hueShift}, 80%, 50%), hsl(${180 + hueShift * 0.5}, 80%, 50%), transparent)`,
        opacity: 0.3, zIndex: 0,
      }} />
    </div>
  );
};
