import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";

/**
 * 超级发光文字 — 支持 glow/glitch/chromaticAberration 三种模式
 * - glow: 标准多层发光
 * - glitch: RGB 偏移 + 抖动
 * - chromaticAberration: RGB 三色分离光晕
 */
export const GlowText: React.FC<{
  text: string;
  fontSize?: number;
  color?: string;
  glowColor?: string;
  delay?: number;
  mode?: "glow" | "glitch" | "chromatic";
  style?: React.CSSProperties;
}> = ({
  text,
  fontSize = 64,
  color = "#ffffff",
  glowColor = "#a855f7",
  delay = 0,
  mode = "glow",
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const entrance = spring({
    frame: Math.max(0, frame - delay),
    fps,
    config: { damping: 200, stiffness: 120 },
  });
  const glowPulse = Math.sin(frame * 0.03) * 0.2 + 0.8;
  const glitchOffset = mode === "glitch" ? Math.sin(frame * 0.8) * 0.4 : 0;

  const scale = interpolate(entrance, [0, 1], [0.6, 1], { extrapolateRight: "clamp" });
  const opacity = entrance;

  // 色差偏移量 (chromatic aberration)
  const caOffset = mode === "chromatic" ? 3 : 0;

  return (
    <div
      style={{
        opacity,
        display: "inline-block",
        position: "relative",
        ...style,
      }}
    >
      <div style={{ transform: `scale(${scale})`, display: "inline-block", position: "relative" }}>
        {/* 底部光晕层 */}
        <span
          style={{
            position: "absolute",
            left: 0, top: 0, right: 0, bottom: 0,
            fontSize,
            fontWeight: 900,
            color: "transparent",
            textShadow: `0 0 ${80 * glowPulse}px ${glowColor}, 0 0 ${160 * glowPulse}px ${glowColor}66`,
            WebkitTextStroke: `1px ${glowColor}33`,
            letterSpacing: "0.04em",
            fontFamily: "'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
            zIndex: 1,
          }}
        >
          {text}
        </span>

        {/* 色差红色偏移 (chromatic) */}
        {mode === "chromatic" && (
          <span
            style={{
              position: "absolute",
              left: caOffset, top: 0, right: 0, bottom: 0,
              fontSize,
              fontWeight: 900,
              color: "transparent",
              textShadow: `0 0 ${40 * glowPulse}px rgba(255, 50, 50, 0.6)`,
              zIndex: 2,
              letterSpacing: "0.04em",
              fontFamily: "'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
              mixBlendMode: "screen" as const,
            }}
          >
            {text}
          </span>
        )}

        {/* 色差蓝色偏移 (chromatic) */}
        {mode === "chromatic" && (
          <span
            style={{
              position: "absolute",
              left: -caOffset, top: 0, right: 0, bottom: 0,
              fontSize,
              fontWeight: 900,
              color: "transparent",
              textShadow: `0 0 ${40 * glowPulse}px rgba(50, 50, 255, 0.6)`,
              zIndex: 2,
              letterSpacing: "0.04em",
              fontFamily: "'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
              mixBlendMode: "screen" as const,
            }}
          >
            {text}
          </span>
        )}

        {/* glitch 抖动偏移层 */}
        {mode === "glitch" && (
          <span
            style={{
              position: "absolute",
              left: glitchOffset * 6, top: glitchOffset * 2, right: 0, bottom: 0,
              fontSize,
              fontWeight: 900,
              color: "transparent",
              textShadow: `0 0 30px #22d3ee`,
              zIndex: 2,
              letterSpacing: "0.04em",
              fontFamily: "'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
              clipPath: `inset(${40 + glitchOffset * 20}% 0 ${40 - glitchOffset * 20}% 0)`,
              opacity: 0.5,
            }}
          >
            {text}
          </span>
        )}

        {/* 主文字层 */}
        <span
          style={{
            position: "relative",
            fontSize,
            fontWeight: 900,
            color,
            textShadow: `0 0 ${40 * glowPulse}px ${glowColor}, 0 0 ${80 * glowPulse}px ${glowColor}44, 0 4px 12px rgba(0,0,0,0.5)`,
            letterSpacing: "0.04em",
            fontFamily: "'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
            zIndex: 3,
          }}
        >
          {text}
        </span>
      </div>
    </div>
  );
};
