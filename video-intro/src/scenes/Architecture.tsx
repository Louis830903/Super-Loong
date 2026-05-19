import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import { ParticleBg } from "../components/ParticleBg";
import { NeonGrid } from "../components/NeonGrid";
import { GlowText } from "../components/GlowText";
import { Subtitle } from "../components/Subtitle";
import type { SubtitleItem } from "../components/Subtitle";

/** 架构模块 */
const MODULES = [
  { name: "Web UI", color: "#a855f7", x: 360, y: 180, desc: "React 仪表盘" },
  { name: "API Gateway", color: "#22d3ee", x: 360, y: 360, desc: "Fastify 路由" },
  { name: "Core Engine", color: "#f97316", x: 360, y: 540, desc: "Agent 调度" },
  { name: "HRR Memory", color: "#34d399", x: 360, y: 720, desc: "向量·FTS5" },
  { name: "IM Gateway", color: "#f472b6", x: 960, y: 270, desc: "飞书·钉钉·微信" },
  { name: "Evolution", color: "#fbbf24", x: 960, y: 450, desc: "自修改引擎" },
  { name: "Knowledge", color: "#60a5fa", x: 960, y: 630, desc: "知识库 RAG" },
  { name: "Video Forge", color: "#fb923c", x: 1560, y: 360, desc: "视频生成" },
  { name: "Skill System", color: "#c084fc", x: 1560, y: 540, desc: "MCP·插件" },
  { name: "Sandbox", color: "#4ade80", x: 1560, y: 720, desc: "三级安全" },
];

/** 连线 */
const LINES = [
  [0, 1], [1, 2], [2, 3], // Web → API → Core → Memory
  [1, 4], [2, 5], [3, 6], // 右侧: IM → Evolution → Knowledge
  [5, 7], [4, 8], [6, 9], // 最右: Evolution → Video, IM → Skill, Knowledge → Sandbox
];

/** 架构节点 */
const Node: React.FC<{ name: string; color: string; x: number; y: number; desc: string; delay: number }> = ({
  name, color, x, y, desc, delay,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const entrance = spring({
    frame: Math.max(0, frame - delay),
    fps,
    config: { damping: 14, stiffness: 120 },
  });
  const pulse = Math.sin(frame * 0.05 + delay * 0.1) * 0.3 + 0.7;

  return (
    <div style={{ position: "absolute", left: x, top: y, opacity: entrance }}>
      <div style={{
        transform: `scale(${interpolate(entrance, [0, 1], [0.3, 1], { extrapolateRight: "clamp" })})`,
        display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
        padding: "12px 20px", borderRadius: 12,
        background: `linear-gradient(135deg, ${color}20, ${color}05)`,
        border: `1.5px solid ${color}44`,
        boxShadow: `0 0 ${30 * pulse}px ${color}33`,
        backdropFilter: "blur(8px)",
      }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: "#fff", letterSpacing: "0.04em" }}>
          {name}
        </div>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", letterSpacing: "0.04em" }}>
          {desc}
        </div>
      </div>
    </div>
  );
};

/** 连线组件 */
const Connection: React.FC<{ x1: number; y1: number; x2: number; y2: number; color: string; delay: number }> = ({
  x1, y1, x2, y2, color, delay,
}) => {
  const frame = useCurrentFrame();
  const length = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
  const angle = Math.atan2(y2 - y1, x2 - x1) * (180 / Math.PI);

  const grow = interpolate(Math.max(0, frame - delay), [0, 20], [0, 1], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });

  return (
    <div style={{
      position: "absolute", left: x1 + 40, top: y1 + 20,
      width: length * grow, height: 1,
      background: `linear-gradient(90deg, ${color}66, ${color}22)`,
      transform: `rotate(${angle}deg)`,
      transformOrigin: "0 0",
      boxShadow: `0 0 6px ${color}44`,
    }} />
  );
};

/** 场景4: 技术架构 32.33-39s (200f) */
export const Architecture: React.FC<{ subtitles: SubtitleItem[] }> = ({ subtitles }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleSpring = spring({ frame, fps, config: { damping: 200, stiffness: 120 } });

  return (
    <div style={{ flex: 1, position: "relative", width: "100%", height: "100%" }}>
      <NeonGrid color="#60a5fa" opacity={0.08} />
      <ParticleBg count={40} intensity="low" />

      <div style={{ position: "absolute", inset: 0, zIndex: 10 }}>
        <div style={{ textAlign: "center", paddingTop: 36 }}>
          <GlowText text="技术架构一览" fontSize={46} color="#ffffff" glowColor="#60a5fa" delay={0} />
        </div>

        <div style={{ position: "relative", width: "100%", height: "100%" }}>
          {/* 连线层 zIndex:8 */}
          {LINES.map(([from, to], i) => (
            <Connection
              key={i}
              x1={MODULES[from].x} y1={MODULES[from].y}
              x2={MODULES[to].x} y2={MODULES[to].y}
              color={MODULES[to].color}
              delay={30 + i * 3}
            />
          ))}

          {/* 节点层 zIndex:11 */}
          {MODULES.map((m, i) => (
            <Node key={i} {...m} delay={10 + i * 4} />
          ))}
        </div>
      </div>

      <Subtitle items={subtitles} />
    </div>
  );
};
