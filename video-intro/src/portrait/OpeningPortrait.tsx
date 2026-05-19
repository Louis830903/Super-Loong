import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import { GlowText } from "../components/GlowText";
import { ParticleBg } from "../components/ParticleBg";

/**
 * 竖屏开场（150f / 5s）
 * 1080×1920，超大字 Super Loong + slogan + 数据条
 */
export const OpeningPortrait: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const subtitleSpring = spring({
    frame: Math.max(0, frame - 25),
    fps,
    config: { damping: 200, stiffness: 100 },
  });
  const subtitleY = interpolate(subtitleSpring, [0, 1], [60, 0]);
  const subtitleOpacity = subtitleSpring;

  const sloganSpring = spring({
    frame: Math.max(0, frame - 50),
    fps,
    config: { damping: 200, stiffness: 100 },
  });
  const sloganOpacity = sloganSpring;

  // 三柱核心数据（口径与 README 一致）：211 专家 / 16 行业 / 3 大 IM
  const stats = [
    { v: "211", l: "专家 Agent" },
    { v: "16", l: "行业全覆盖" },
    { v: "3", l: "大平台 IM" },
  ];

  return (
    <AbsoluteFill style={{ backgroundColor: "#06060e" }}>
      {/* zIndex:1 粒子背景（组件自带） */}
      <ParticleBg count={60} intensity="normal" mode="flow" />

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
        {/* 主标题 Super Loong */}
        <GlowText text="Super Loong" fontSize={180} color="#ffffff" glowColor="#a855f7" delay={0} mode="chromatic" />

        {/* 副标题 */}
        <div style={{
          marginTop: 40,
          fontSize: 56,
          fontWeight: 700,
          color: "#ffffff",
          letterSpacing: "0.08em",
          textAlign: "center",
          fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
          opacity: subtitleOpacity,
          transform: `translateY(${subtitleY}px)`,
          textShadow: "0 0 30px rgba(168,85,247,0.6)",
        }}>
          下一代模块化 AI Agent 平台
        </div>

        {/* slogan */}
        <div style={{
          marginTop: 32,
          fontSize: 40,
          color: "#a855f7",
          letterSpacing: "0.2em",
          fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
          opacity: sloganOpacity,
        }}>
          一切皆可 Agent
        </div>

        {/* 数据三柱 */}
        <div style={{
          marginTop: 100,
          display: "flex",
          gap: 80,
          opacity: sloganOpacity,
        }}>
          {stats.map((s, i) => (
            <div key={i} style={{ textAlign: "center" }}>
              <div style={{
                fontSize: 96,
                fontWeight: 900,
                color: "#ffffff",
                fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
                textShadow: "0 0 40px rgba(168,85,247,0.8)",
              }}>{s.v}</div>
              <div style={{
                fontSize: 36,
                color: "rgba(255,255,255,0.7)",
                marginTop: 8,
                fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
              }}>{s.l}</div>
            </div>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
};
