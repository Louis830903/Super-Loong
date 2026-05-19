import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import { ParticleBg } from "../components/ParticleBg";
import { GlowText } from "../components/GlowText";
import { NeonGrid } from "../components/NeonGrid";
import { Subtitle } from "../components/Subtitle";
import type { SubtitleItem } from "../components/Subtitle";

/** 核心数据 */
const STATS = [
  { value: 211, label: "内置专家", suffix: "+", color: "#a855f7" },
  { value: 36, label: "内置工具", suffix: "", color: "#22d3ee" },
  { value: 34, label: "进化模块", suffix: "", color: "#f97316" },
  { value: 3, label: "IM 平台", suffix: "", color: "#34d399" },
];

/** 数字翻转组件 */
const FlipCounter: React.FC<{
  value: number; suffix: string; label: string; color: string; delay: number;
}> = ({ value, suffix, label, color, delay }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const entrance = spring({
    frame: Math.max(0, frame - delay),
    fps,
    config: { damping: 200, stiffness: 120 },
  });

  const displayValue = interpolate(entrance, [0, 1], [0, value], { extrapolateRight: "clamp" });

  return (
    <div style={{ opacity: entrance, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
      {/* transform 在内层 wrapper */}
      <div style={{ transform: `scale(${interpolate(entrance, [0, 1], [0.5, 1], { extrapolateRight: "clamp" })})` }}>
        <div style={{
          fontSize: 48, fontWeight: 900, color,
          textShadow: `0 0 30px ${color}, 0 0 60px ${color}66`,
          fontFamily: "monospace",
        }}>
          {Math.floor(displayValue)}<span style={{ fontSize: 24 }}>{suffix}</span>
        </div>
      </div>
      <div style={{ fontSize: 14, color: "rgba(255,255,255,0.5)", letterSpacing: "0.06em" }}>
        {label}
      </div>
    </div>
  );
};

/** 场景1: 爆炸开场 0-4.67s (140f) */
export const Opening: React.FC<{ subtitles: SubtitleItem[] }> = ({ subtitles }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const burst = spring({ frame, fps, config: { damping: 12, stiffness: 60, mass: 2 } });

  return (
    <div style={{ flex: 1, position: "relative", width: "100%", height: "100%" }}>
      {/* zIndex:0 背景网格 */}
      <NeonGrid color="#a855f7" opacity={0.08} />
      {/* zIndex:1 粒子背景 */}
      <ParticleBg count={120} intensity="high" mode="burst" />

      {/* zIndex:5 爆炸光晕 */}
      <div style={{
        position: "absolute", left: "50%", top: "50%",
        width: 700, height: 700,
        transform: `translate(-50%, -50%) scale(${burst * 2})`,
        borderRadius: "50%",
        background: "radial-gradient(circle, rgba(168,85,247,0.18) 0%, rgba(34,211,238,0.1) 35%, transparent 65%)",
        pointerEvents: "none",
        zIndex: 5,
      }} />

      {/* zIndex:10 主内容 */}
      <div style={{
        position: "absolute", inset: 0, zIndex: 10,
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      }}>
        <GlowText text="Super Loong" fontSize={150} color="#ffffff" glowColor="#a855f7" delay={0} mode="chromatic" />
        <GlowText
          text="下一代模块化 AI Agent 平台"
          fontSize={44}
          color="rgba(255,255,255,0.8)"
          glowColor="#22d3ee"
          delay={12}
          style={{ marginTop: 20 }}
        />
        <GlowText
          text="一切皆可 Agent"
          fontSize={34}
          color="rgba(255,255,255,0.5)"
          glowColor="#f97316"
          delay={28}
          style={{ marginTop: 12 }}
        />

        <div style={{ display: "flex", gap: 50, marginTop: 44 }}>
          {STATS.map((s, i) => (
            <FlipCounter key={i} {...s} delay={40 + i * 8} />
          ))}
        </div>
      </div>

      <Subtitle items={subtitles} />
    </div>
  );
};
