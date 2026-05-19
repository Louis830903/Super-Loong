import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import { ParticleBg } from "../components/ParticleBg";
import { NeonGrid } from "../components/NeonGrid";
import { GlowText } from "../components/GlowText";
import { DataBar } from "../components/DataBar";
import { Subtitle } from "../components/Subtitle";
import type { SubtitleItem } from "../components/Subtitle";

const END_STATS = [
  { value: 211, label: "内置专家", color: "#a855f7", suffix: "+" },
  { value: 36, label: "内置工具", color: "#22d3ee", suffix: "" },
  { value: 3, label: "IM 平台", color: "#34d399", suffix: "" },
  { value: 40, label: "K+ 代码", color: "#f97316", suffix: "" },
  { value: 8, label: "模型商", color: "#fbbf24", suffix: "+" },
];

/** 场景5: CTA 总攻 48-60s (370f) */
export const Outro: React.FC<{ subtitles: SubtitleItem[] }> = ({ subtitles }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // 注意: 无场景末尾 fadeOut，由 TransitionSeries.Transition 处理过渡

  const titleSpring = spring({ frame, fps, config: { damping: 200, stiffness: 120 } });
  const subtitleSpring = spring({ frame: Math.max(0, frame - 16), fps, config: { damping: 200, stiffness: 120 } });
  const urlSpring = spring({ frame: Math.max(0, frame - 32), fps, config: { damping: 14, stiffness: 120 } });
  const descSpring = spring({ frame: Math.max(0, frame - 50), fps, config: { damping: 200, stiffness: 120 } });
  const statsSpring = spring({ frame: Math.max(0, frame - 66), fps, config: { damping: 200, stiffness: 120 } });
  const ctaSpring = spring({ frame: Math.max(0, frame - 84), fps, config: { damping: 14, stiffness: 120 } });

  const pulse = Math.sin(frame * 0.06) * 0.08 + 1;
  const glowPulse = Math.sin(frame * 0.04) * 0.15 + 0.85;

  return (
    <div style={{ flex: 1, position: "relative", width: "100%", height: "100%" }}>
      <NeonGrid color="#a855f7" opacity={0.1} />
      <ParticleBg count={80} intensity="high" />

      <div style={{ position: "absolute", inset: 0, zIndex: 10, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        {/* 标题 */}
        <div style={{ opacity: titleSpring }}>
          <div style={{
            transform: `scale(${interpolate(titleSpring, [0, 1], [0.6, 1], { extrapolateRight: "clamp" })})`,
          }}>
            <div style={{
              fontSize: 90, fontWeight: 900, color: "#ffffff", letterSpacing: "0.06em",
              textShadow: `0 0 ${60 * glowPulse}px #a855f7, 0 0 ${120 * glowPulse}px #a855f7, 0 0 ${180 * glowPulse}px #22d3ee`,
              marginBottom: 14,
            }}>Super Loong</div>
          </div>
        </div>

        {/* 副标题 */}
        <div style={{
          opacity: subtitleSpring,
          fontSize: 28, color: "rgba(255,255,255,0.6)", marginBottom: 36, letterSpacing: "0.1em",
        }}>
          <div style={{
            transform: `scale(${interpolate(subtitleSpring, [0, 1], [0.6, 1], { extrapolateRight: "clamp" })})`,
          }}>
            下一代模块化 AI Agent 平台
          </div>
        </div>

        {/* GitHub 地址 */}
        <div style={{
          opacity: urlSpring,
          padding: "24px 56px", background: "rgba(255,255,255,0.06)",
          border: `2px solid rgba(168, 85, 247, ${0.4 + glowPulse * 0.3})`,
          borderRadius: 20, marginBottom: 32, backdropFilter: "blur(10px)",
          boxShadow: `0 0 ${60 * glowPulse}px rgba(168, 85, 247, 0.4), 0 0 ${120 * glowPulse}px rgba(34, 211, 238, 0.2)`,
        }}>
          <div style={{ 
            transform: `scale(${0.85 + interpolate(urlSpring, [0, 1], [0, 0.15], { extrapolateRight: "clamp" }) + pulse * 0.05})`,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6, justifyContent: "center" }}>
              <span style={{ fontSize: 20, color: "rgba(255,255,255,0.4)" }}>⭐</span>
              <span style={{ fontSize: 34, fontWeight: 700, color: "#22d3ee", letterSpacing: "0.03em", fontFamily: "monospace" }}>
                github.com/Louis830903/Super-Loong
              </span>
              <span style={{ fontSize: 20, color: "rgba(255,255,255,0.4)" }}>⭐</span>
            </div>
            <div style={{ fontSize: 13, color: "rgba(255,255,255,0.3)", textAlign: "center", letterSpacing: "0.06em" }}>
              STAR ★ FORK ★ WATCH — 开源 MIT 协议
            </div>
          </div>
        </div>

        {/* 功能标签云 */}
        <div style={{
          opacity: descSpring,
          fontSize: 18, color: "rgba(255,255,255,0.4)", marginBottom: 30,
          textAlign: "center", lineHeight: 1.8, letterSpacing: "0.05em",
        }}>
          <div style={{ transform: `translateY(${interpolate(descSpring, [0, 1], [12, 0], { extrapolateRight: "clamp" })}px)` }}>
            桌面操控 · 211 专家 · 自我进化 · 三平台 IM · 视频生成 · 知识库 · MCP 生态 · 安全沙箱
          </div>
        </div>

        {/* 数据统计条 */}
        <div style={{ opacity: statsSpring, display: "flex", gap: 44, marginBottom: 36 }}>
          {END_STATS.map((stat, i) => (
            <div key={i} style={{
              opacity: interpolate(
                spring({ frame: Math.max(0, frame - (66 + i * 5)), fps, config: { damping: 14, stiffness: 120 } }),
                [0, 1], [0, 1], { extrapolateRight: "clamp" }
              ),
            }}>
              <div style={{ transform: `scale(${interpolate(
                spring({ frame: Math.max(0, frame - (66 + i * 5)), fps, config: { damping: 14, stiffness: 120 } }),
                [0, 1], [0.4, 1], { extrapolateRight: "clamp" }
              )})`, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                <div style={{
                  fontSize: 44, fontWeight: 900, color: stat.color,
                  textShadow: `0 0 20px ${stat.color}`, fontFamily: "monospace",
                }}>
                  {stat.value}<span style={{ fontSize: 22 }}>{stat.suffix}</span>
                </div>
                <div style={{ fontSize: 13, color: "rgba(255,255,255,0.4)", letterSpacing: "0.04em" }}>{stat.label}</div>
              </div>
            </div>
          ))}
        </div>

        {/* CTA 按钮 */}
        <div style={{
          opacity: interpolate(ctaSpring, [0, 1], [0, 1], { extrapolateRight: "clamp" }),
        }}>
          <div style={{
            transform: `scale(${interpolate(ctaSpring, [0, 1], [0.5, 1], { extrapolateRight: "clamp" })})`,
            padding: "16px 52px", borderRadius: 30,
            background: "linear-gradient(135deg, #a855f7, #22d3ee)",
            boxShadow: `0 0 40px rgba(168, 85, 247, 0.5), 0 0 80px rgba(34, 211, 238, 0.3)`,
          }}>
            <span style={{ fontSize: 24, fontWeight: 800, color: "#ffffff", letterSpacing: "0.06em" }}>
              🚀 立即 Star · 开启 Agent 之旅
            </span>
          </div>
        </div>
      </div>

      <Subtitle items={subtitles} />
    </div>
  );
};
