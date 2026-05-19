import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import { ParticleBg } from "../components/ParticleBg";
import { NeonGrid } from "../components/NeonGrid";
import { GlowText } from "../components/GlowText";
import { OrbitalRing } from "../components/OrbitalRing";
import { Subtitle } from "../components/Subtitle";
import type { SubtitleItem } from "../components/Subtitle";

/** 三大杀招 */
const KILLER_FEATURES = [
  {
    icon: "🧬", title: "自我进化引擎",
    desc: "源码级自修改·Diff审查·沙箱验证",
    tag: "34 进化模块",
    color: "#f97316",
  },
  {
    icon: "🎬", title: "端到端视频生成",
    desc: "一句话出片·ComfyUI·全自动渲染",
    tag: "零门槛创作",
    color: "#fbbf24",
  },
  {
    icon: "🔒", title: "三级安全沙箱",
    desc: "Process → Docker → SSH",
    tag: "纵深防御",
    color: "#60a5fa",
  },
];

/** 单杀招面板 */
const KillerPanel: React.FC<{
  icon: string; title: string; desc: string; tag: string; color: string;
  delay: number; isLarge?: boolean;
}> = ({ icon, title, desc, tag, color, delay, isLarge }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const entrance = spring({
    frame: Math.max(0, frame - delay),
    fps,
    config: { damping: 14, stiffness: 120 },
  });
  const pulse = Math.sin(frame * 0.04 + delay * 0.1) * 0.5 + 0.5;

  return (
    <div style={{ opacity: entrance }}>
      <div style={{
        transform: `scale(${interpolate(entrance, [0, 1], [0.5, 1], { extrapolateRight: "clamp" })}) translateY(${interpolate(entrance, [0, 1], [30, 0], { extrapolateRight: "clamp" })}px)`,
        display: "flex", flexDirection: "column", alignItems: "center", gap: isLarge ? 24 : 16,
        padding: isLarge ? "48px 64px" : "32px 48px", borderRadius: 28,
        background: `linear-gradient(135deg, ${color}12, rgba(255,255,255,0.02))`,
        border: `2px solid ${color}44`,
        backdropFilter: "blur(20px)",
        boxShadow: `0 0 ${60 * pulse}px ${color}22, 0 0 ${120 * pulse}px ${color}0a, inset 0 1px 0 ${color}22`,
      }}>
        <div style={{
          width: isLarge ? 120 : 80, height: isLarge ? 120 : 80, borderRadius: 28,
          background: `linear-gradient(135deg, ${color}30, ${color}0a)`,
          display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: `0 0 ${50 * pulse}px ${color}55, inset 0 1px 0 ${color}33`,
          fontSize: isLarge ? 56 : 40,
        }}>
          {icon}
        </div>
        <div style={{ fontSize: isLarge ? 44 : 32, fontWeight: 800, color: "#fff", letterSpacing: "0.02em", fontFamily: "'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif" }}>
          {title}
        </div>
        <div style={{ fontSize: isLarge ? 20 : 16, color: "rgba(255,255,255,0.55)", letterSpacing: "0.03em", textAlign: "center", fontFamily: "'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif" }}>
          {desc}
        </div>
        <div style={{
          padding: "6px 20px", borderRadius: 12,
          background: `${color}20`, border: `1px solid ${color}44`,
          fontSize: 14, fontWeight: 700, color, letterSpacing: "0.03em", fontFamily: "'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
          boxShadow: `0 0 20px ${color}22`,
        }}>
          {tag}
        </div>
      </div>
    </div>
  );
};

/** 场景3: 三大杀招 12.33-22.33s (300f) */
export const KillerFeature: React.FC<{ subtitles: SubtitleItem[] }> = ({ subtitles }) => {
  const frame = useCurrentFrame();

  return (
    <div style={{ flex: 1, position: "relative", width: "100%", height: "100%" }}>
      <NeonGrid color="#f97316" opacity={0.07} />
      <ParticleBg count={60} intensity="normal" />

      {/* 中央 OrbitalRing 双环 zIndex:3 */}
      <OrbitalRing size={700} tilt={65} color="#f97316" particleCount={12} ringOpacity={0.12} />
      <OrbitalRing size={500} tilt={55} color="#fbbf24" particleCount={8} ringOpacity={0.1} />

      {/* burst 粒子点缀 zIndex:2 */}
      {frame > 200 && frame < 280 && (
        <ParticleBg count={30} intensity="high" mode="burst" zIndex={2} />
      )}

      {/* 主内容 zIndex:10 */}
      <div style={{ position: "absolute", inset: 0, zIndex: 10, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <GlowText text="三大核心杀招" fontSize={54} color="#ffffff" glowColor="#fbbf24" delay={0} style={{ marginBottom: 48 }} />

        {/* 布局: 第一行 1 个大型面板(居中), 第二行 2 个面板 */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 24 }}>
          {/* 第一行: 进化引擎 (大) */}
          <KillerPanel {...KILLER_FEATURES[0]} delay={12} isLarge />

          {/* 第二行: 视频生成 + 安全沙箱 */}
          <div style={{ display: "flex", gap: 32 }}>
            <KillerPanel {...KILLER_FEATURES[1]} delay={28} />
            <KillerPanel {...KILLER_FEATURES[2]} delay={40} />
          </div>
        </div>
      </div>

      <Subtitle items={subtitles} />
    </div>
  );
};
