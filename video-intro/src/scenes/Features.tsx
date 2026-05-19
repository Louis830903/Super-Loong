import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import { ParticleBg } from "../components/ParticleBg";
import { NeonGrid } from "../components/NeonGrid";
import { GlowText } from "../components/GlowText";
import { Subtitle } from "../components/Subtitle";
import type { SubtitleItem } from "../components/Subtitle";

/** 8 大核心能力 */
const FEATURES = [
  { icon: "🧠", title: "211 内置专家", tag: "16行业·语义自动匹配", color: "#a855f7" },
  { icon: "🔮", title: "HRR 向量记忆", tag: "符号绑定·知识图谱·FTS5", color: "#22d3ee" },
  { icon: "🧬", title: "自我进化引擎", tag: "源码自修改·Diff·34模块", color: "#f97316" },
  { icon: "💬", title: "三平台 IM", tag: "飞书·钉钉·企业微信", color: "#34d399" },
  { icon: "🖱️", title: "桌面精确操控", tag: "鼠键·截屏·OCR·窗口", color: "#f472b6" },
  { icon: "🎬", title: "端到端视频生成", tag: "ComfyUI·一句话出片", color: "#fbbf24" },
  { icon: "🔒", title: "三级安全沙箱", tag: "Process→Docker→SSH", color: "#60a5fa" },
  { icon: "🤝", title: "A2A 多Agent协作", tag: "跨进程·层级/并行/串行", color: "#fb923c" },
];

const CARD_DURATION = 26; // 每卡展示帧数 (8×26=208, 留2f余量)

/** 单张能力卡片 */
const FeatureCard: React.FC<{
  icon: string; title: string; tag: string; color: string;
  activeFrame: number;
}> = ({ icon, title, tag, color, activeFrame }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const localFrame = frame - activeFrame;
  const enter = spring({
    frame: Math.max(0, Math.min(localFrame, 12)),
    fps,
    config: { damping: 14, stiffness: 120 },
  });
  const exit = interpolate(localFrame, [CARD_DURATION - 8, CARD_DURATION], [1, 0], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });

  return (
    <div style={{ opacity: enter * exit }}>
      {/* transform 放内层 wrapper，外层纯布局 */}
      <div style={{
        transform: `scale(${interpolate(enter, [0, 1], [0.4, 1])}) translateY(${interpolate(enter, [0, 1], [60, 0])}px)`,
        display: "flex", flexDirection: "column", alignItems: "center", gap: 20,
        padding: "40px 48px", borderRadius: 24,
        background: `linear-gradient(135deg, ${color}10, rgba(255,255,255,0.03))`,
        border: `1.5px solid ${color}33`,
        backdropFilter: "blur(16px)",
        boxShadow: `0 0 50px ${color}15, 0 0 100px ${color}05`,
      }}>
        <div style={{
          width: 96, height: 96, borderRadius: 24,
          background: `linear-gradient(135deg, ${color}25, ${color}08)`,
          display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: `0 0 40px ${color}44, inset 0 1px 0 ${color}33`,
          fontSize: 48,
        }}>
          {icon}
        </div>
        <div style={{ fontSize: 36, fontWeight: 800, color: "#fff", letterSpacing: "0.04em" }}>
          {title}
        </div>
        <div style={{ fontSize: 18, color: "rgba(255,255,255,0.45)", letterSpacing: "0.06em" }}>
          {tag}
        </div>
      </div>
    </div>
  );
};

/** 场景2: 8大能力快速轮播 5-12s (210f) */
export const Features: React.FC<{ subtitles: SubtitleItem[] }> = ({ subtitles }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleSpring = spring({ frame, fps, config: { damping: 200, stiffness: 120 } });
  const activeIndex = Math.min(Math.floor(frame / CARD_DURATION), FEATURES.length - 1);

  return (
    <div style={{ flex: 1, position: "relative", width: "100%", height: "100%" }}>
      <NeonGrid color="#22d3ee" opacity={0.06} />
      <ParticleBg count={50} intensity="low" />

      <div style={{ position: "absolute", inset: 0, zIndex: 10, display: "flex", flexDirection: "column", alignItems: "center", padding: "40px 80px" }}>
        <GlowText text="八大核心能力" fontSize={48} color="#ffffff" glowColor="#a855f7" delay={0} style={{ marginBottom: 48 }} />

        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", width: "100%" }}>
          {FEATURES.map((f, i) => (
            <div key={i} style={{ position: "absolute", display: frame >= i * CARD_DURATION && frame < (i + 1) * CARD_DURATION ? "block" : "none" }}>
              <FeatureCard {...f} activeFrame={i * CARD_DURATION} />
            </div>
          ))}
        </div>

        {/* 进度条 */}
        <div style={{ display: "flex", gap: 6, marginTop: 24 }}>
          {FEATURES.map((f, i) => (
            <div key={i} style={{
              width: 40, height: 4, borderRadius: 2,
              background: i <= activeIndex ? f.color : "rgba(255,255,255,0.1)",
            }} />
          ))}
        </div>
      </div>

      <Subtitle items={subtitles} />
    </div>
  );
};
