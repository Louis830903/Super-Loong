import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import { ParticleBg } from "../components/ParticleBg";
import { NeonGrid } from "../components/NeonGrid";
import { GlowText } from "../components/GlowText";
import { Subtitle } from "../components/Subtitle";
import type { SubtitleItem } from "../components/Subtitle";

/** 竞品名称与颜色 */
const COMPETITORS = [
  { name: "Super Loong", color: "#a855f7", isUs: true },
  { name: "Manus", color: "#60a5fa", isUs: false },
  { name: "CrewAI", color: "#9ca3af", isUs: false },
  { name: "AutoGPT", color: "#d4a56a", isUs: false },
];

/** 五维对比数据（数值越大越好） */
const DIMENSIONS = [
  {
    label: "内置专家数",
    values: [211, 20, 15, 10],
    max: 220,
    suffix: "+",
    tag: "211 vs 竞品 <20",
  },
  {
    label: "进化能力",
    values: [34, 5, 8, 3],
    max: 40,
    suffix: " 模块",
    tag: "34 vs 竞品 <10",
  },
  {
    label: "多平台 IM",
    values: [3, 1, 1, 2],
    max: 5,
    suffix: " 平台",
    tag: "三平台全覆盖",
  },
  {
    label: "视频生成",
    values: [100, 0, 0, 0],
    max: 100,
    suffix: "%",
    tag: "独家视频能力",
  },
  {
    label: "安全沙箱",
    values: [3, 1, 0, 1],
    max: 3,
    suffix: " 级",
    tag: "三级纵深防御",
  },
];

const DIM_HEIGHT = 110;    // 每维度行高
const DIM_START_Y = 200;   // 第一行 Y 起点
const DIM_INTERVAL = 40;   // 每维度入场间隔
const BAR_MAX_WIDTH = 320; // 最大柱宽

/** 单维度对比行 */
const DimensionRow: React.FC<{
  label: string;
  values: number[];
  max: number;
  suffix: string;
  colors: string[];
  dimIndex: number;
}> = ({ label, values, max, suffix, colors, dimIndex }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const startFrame = 40 + dimIndex * DIM_INTERVAL;
  const localFrame = Math.max(0, frame - startFrame);

  const entrance = spring({
    frame: Math.min(localFrame, 12),
    fps,
    config: { damping: 14, stiffness: 120 },
  });

  const translateY = interpolate(entrance, [0, 1], [20, 0], {
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        position: "absolute",
        top: DIM_START_Y + dimIndex * DIM_HEIGHT,
        left: 0,
        right: 0,
        height: DIM_HEIGHT,
        opacity: entrance,
        display: "flex",
        alignItems: "center",
        paddingLeft: 60,
        gap: 24,
      }}
    >
      {/* transform 在内层 wrapper */}
      <div
        style={{
          transform: `translateY(${translateY}px)`,
          display: "flex",
          alignItems: "center",
          width: "100%",
          gap: 24,
        }}
      >
        {/* 维度标签 */}
        <div
          style={{
            width: 120,
            fontSize: 15,
            fontWeight: 700,
            color: "rgba(255,255,255,0.6)",
            letterSpacing: "0.05em",
            textAlign: "right",
            flexShrink: 0,
          }}
        >
          {label}
        </div>

        {/* 四条柱状图 */}
        {values.map((v, ci) => {
          const barWidth = interpolate(
            entrance,
            [0, 1],
            [0, (v / max) * BAR_MAX_WIDTH],
            { extrapolateRight: "clamp" }
          );
          const glow = Math.sin(frame * 0.05 + dimIndex + ci) * 0.3 + 0.7;

          return (
            <div
              key={ci}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 4,
                flex: 1,
                maxWidth: BAR_MAX_WIDTH + 40,
              }}
            >
              {/* 数值标签 */}
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 800,
                  color: colors[ci],
                  fontFamily: "monospace",
                  textShadow: `0 0 10px ${colors[ci]}66`,
                  height: 20,
                  display: "flex",
                  alignItems: "center",
                }}
              >
                {Math.floor(interpolate(entrance, [0, 1], [0, v], { extrapolateRight: "clamp" }))}
                {suffix}
              </div>
              {/* 柱体 */}
              <div
                style={{
                  width: BAR_MAX_WIDTH,
                  height: 28,
                  borderRadius: 6,
                  background: "rgba(255,255,255,0.03)",
                  border: `1px solid ${colors[ci]}22`,
                  display: "flex",
                  alignItems: "center",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: barWidth,
                    height: 22,
                    borderRadius: 4,
                    marginLeft: 2,
                    background: `linear-gradient(90deg, ${colors[ci]}88, ${colors[ci]})`,
                    boxShadow: `0 0 ${14 * glow}px ${colors[ci]}66`,
                  }}
                />
              </div>
              {/* 竞品名 */}
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: colors[ci],
                  opacity: 0.6,
                  letterSpacing: "0.04em",
                  marginTop: 2,
                }}
              >
                {COMPETITORS[ci].name}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

/** 场景: 竞品对比 22.67-32s (280f) */
export const Comparison: React.FC<{ subtitles: SubtitleItem[] }> = ({
  subtitles,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleSpring = spring({ frame, fps, config: { damping: 200, stiffness: 120 } });
  const headerSpring = spring({
    frame: Math.max(0, frame - 12),
    fps,
    config: { damping: 200, stiffness: 120 },
  });

  // 汇总高亮阶段 (240-280f)
  const isShowdown = frame >= 240;
  const showdownGlow = isShowdown
    ? Math.sin(frame * 0.08) * 0.3 + 0.7
    : 1;

  const colors = COMPETITORS.map((c) => c.color);

  return (
    <div style={{ flex: 1, position: "relative", width: "100%", height: "100%" }}>
      <NeonGrid color="#a855f7" opacity={0.06} />
      <ParticleBg count={45} intensity="low" />

      {/* 主内容 zIndex:10 */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 10,
          display: "flex",
          flexDirection: "column",
          padding: "30px 80px",
        }}
      >
        {/* 标题 */}
        <div
          style={{
            textAlign: "center",
            marginBottom: 12,
            opacity: titleSpring,
          }}
        >
          <GlowText
            text="竞品实力对比"
            fontSize={48}
            color="#ffffff"
            glowColor="#a855f7"
            delay={0}
          />
        </div>

        {/* 列头 */}
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            gap: 24,
            paddingLeft: 180,
            opacity: headerSpring,
            marginBottom: 12,
          }}
        >
          <div
            style={{
              transform: `scale(${interpolate(headerSpring, [0, 1], [0.5, 1], { extrapolateRight: "clamp" })})`,
            }}
          >
            <div style={{ display: "flex", gap: 24 }}>
              {COMPETITORS.map((c, i) => (
                <div
                  key={i}
                  style={{
                    flex: 1,
                    maxWidth: BAR_MAX_WIDTH + 40,
                    textAlign: "center",
                    fontSize: 14,
                    fontWeight: 800,
                    color: c.color,
                    letterSpacing: "0.05em",
                    textShadow: c.isUs
                      ? `0 0 20px ${c.color}, 0 0 40px ${c.color}66`
                      : "none",
                    padding: "6px 0",
                    borderBottom: `2px solid ${c.color}44`,
                  }}
                >
                  {c.name}
                  {c.isUs && (
                    <span style={{ fontSize: 10, marginLeft: 6, opacity: 0.7 }}>
                      (我们)
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 维度对比行 */}
        <div style={{ position: "relative", flex: 1 }}>
          {DIMENSIONS.map((dim, di) => (
            <DimensionRow
              key={di}
              label={dim.label}
              values={dim.values}
              max={dim.max}
              suffix={dim.suffix}
              colors={colors}
              dimIndex={di}
            />
          ))}
        </div>

        {/* 汇总高亮条 (240-280f) */}
        {isShowdown && (
          <div
            style={{
              position: "absolute",
              bottom: 40,
              left: "50%",
              transform: `translateX(-50%)`,
              opacity: interpolate(
                Math.max(0, frame - 240),
                [0, 12],
                [0, 1],
                { extrapolateRight: "clamp" }
              ),
            }}
          >
            <div
              style={{
                transform: `scale(${interpolate(spring({ frame: Math.max(0, frame - 240), fps, config: { damping: 14, stiffness: 120 } }), [0, 1], [0.3, 1], { extrapolateRight: "clamp" })})`,
                padding: "14px 44px",
                borderRadius: 16,
                background: `linear-gradient(135deg, rgba(168,85,247,${0.3 * showdownGlow}), rgba(34,211,238,${0.15 * showdownGlow}))`,
                border: `2px solid rgba(168,85,247,${0.5 * showdownGlow})`,
                boxShadow: `0 0 ${40 * showdownGlow}px rgba(168,85,247,0.4), 0 0 ${80 * showdownGlow}px rgba(34,211,238,0.2)`,
              }}
            >
              <span
                style={{
                  fontSize: 28,
                  fontWeight: 900,
                  color: "#ffffff",
                  letterSpacing: "0.08em",
                  textShadow: `0 0 30px #a855f7`,
                }}
              >
                🏆 五项全维度碾压级优势
              </span>
            </div>
          </div>
        )}
      </div>

      <Subtitle items={subtitles} />
    </div>
  );
};
