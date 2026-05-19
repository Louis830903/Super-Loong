import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import { GlowText } from "../components/GlowText";
import { ParticleBg } from "../components/ParticleBg";

/**
 * 竖屏 Outro（180f / 6s）
 * Super Loong 大字 + slogan + CTA
 */
export const OutroPortrait: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const sloganSpring = spring({
    frame: Math.max(0, frame - 30),
    fps,
    config: { damping: 200, stiffness: 100 },
  });
  const sloganY = interpolate(sloganSpring, [0, 1], [40, 0]);

  const ctaSpring = spring({
    frame: Math.max(0, frame - 70),
    fps,
    config: { damping: 200, stiffness: 90 },
  });
  const ctaScale = interpolate(ctaSpring, [0, 1], [0.5, 1]);

  const taglineSpring = spring({
    frame: Math.max(0, frame - 110),
    fps,
    config: { damping: 200, stiffness: 100 },
  });

  // 光晕脉动
  const pulse = Math.sin(frame * 0.1) * 0.1 + 1;

  return (
    <AbsoluteFill style={{ backgroundColor: "#06060e" }}>
      {/* zIndex:1 粒子背景（组件自带） */}
      <ParticleBg count={80} intensity="high" mode="burst" />

      {/* zIndex:10 正文层 — 必须显式提升，否则被 ParticleBg 的 radial-gradient 盖住 */}
      <div style={{
        position: "absolute",
        inset: 0,
        zIndex: 10,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        padding: 60,
      }}>
        {/* 主品牌大字 */}
        <div style={{ transform: `scale(${pulse})` }}>
          <GlowText text="Super Loong" fontSize={200} color="#ffffff" glowColor="#a855f7" delay={0} mode="chromatic" />
        </div>

        {/* 副 slogan */}
        <div style={{
          marginTop: 50,
          fontSize: 52,
          fontWeight: 700,
          color: "#ffffff",
          letterSpacing: "0.06em",
          textAlign: "center",
          fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
          opacity: sloganSpring,
          transform: `translateY(${sloganY}px)`,
          textShadow: "0 0 30px rgba(168,85,247,0.7)",
        }}>
          让每个想法 · 都能 Agent
        </div>

        {/* CTA 胶囊 — Star on GitHub */}
        <div style={{
          marginTop: 80,
          padding: "28px 70px",
          borderRadius: 100,
          background: "linear-gradient(90deg, #a855f7, #6d28d9, #3b82f6)",
          color: "#ffffff",
          fontSize: 50,
          fontWeight: 900,
          letterSpacing: "0.08em",
          fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
          boxShadow: "0 0 80px rgba(168,85,247,0.8)",
          opacity: ctaSpring,
          transform: `scale(${ctaScale})`,
          display: "flex",
          alignItems: "center",
          gap: 16,
        }}>
          <span style={{ fontSize: 56 }}>⭐</span>
          <span>Star on GitHub</span>
        </div>

        {/* 真实开源地址 */}
        <div style={{
          marginTop: 32,
          fontSize: 36,
          fontWeight: 700,
          color: "#ffffff",
          letterSpacing: "0.04em",
          textAlign: "center",
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          opacity: taglineSpring,
          textShadow: "0 0 24px rgba(168,85,247,0.7)",
          padding: "12px 32px",
          borderRadius: 16,
          background: "rgba(255,255,255,0.06)",
          border: "1px solid rgba(168,85,247,0.4)",
        }}>
          github.com/Louis830903/Super-Loong
        </div>

        {/* 底部小字 */}
        <div style={{
          marginTop: 28,
          fontSize: 30,
          color: "rgba(255,255,255,0.6)",
          letterSpacing: "0.18em",
          textAlign: "center",
          fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
          opacity: taglineSpring,
        }}>
          MIT 开源 · 免费商用 · 可私有部署
        </div>
      </div>
    </AbsoluteFill>
  );
};
