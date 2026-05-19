import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";

/**
 * 竖屏 KillerFeature（240f / 8s）
 * 三大杀招纵向堆叠，每个卡片间隔进场
 */
// 三大核心杀招（口径锚定 README）：
// 1) 211 专家覆盖 16 行业；2) 34 模块源码级自进化；3) 真·桌面操控（鼠键 + OCR）
const KILLERS = [
  {
    icon: "🧠",
    title: "211 内置专家",
    desc: "16 行业全覆盖 · 智能分配最对口的 Agent",
    color: "#a855f7",
  },
  {
    icon: "🧬",
    title: "源码级自我进化",
    desc: "34 模块进化引擎 · Agent 写代码改自己",
    color: "#3b82f6",
  },
  {
    icon: "🖱️",
    title: "真·桌面操控",
    desc: "鼠键 / 截屏 / OCR — 不是建议，是执行",
    color: "#10b981",
  },
];

const Card: React.FC<{ killer: typeof KILLERS[0]; delay: number }> = ({ killer, delay }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const enter = spring({
    frame: Math.max(0, frame - delay),
    fps,
    config: { damping: 200, stiffness: 90 },
  });
  const x = interpolate(enter, [0, 1], [-300, 0]);
  const opacity = enter;

  return (
    <div style={{
      width: 880,
      padding: "44px 56px",
      borderRadius: 32,
      background: `linear-gradient(135deg, ${killer.color}22, ${killer.color}08)`,
      border: `2px solid ${killer.color}88`,
      boxShadow: `0 0 60px ${killer.color}55`,
      display: "flex",
      alignItems: "center",
      gap: 36,
      opacity,
      transform: `translateX(${x}px)`,
      fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
    }}>
      <div style={{ fontSize: 110, lineHeight: 1 }}>{killer.icon}</div>
      <div style={{ flex: 1 }}>
        <div style={{
          fontSize: 60,
          fontWeight: 900,
          color: "#ffffff",
          marginBottom: 12,
          textShadow: `0 0 20px ${killer.color}aa`,
        }}>
          {killer.title}
        </div>
        <div style={{
          fontSize: 34,
          color: "rgba(255,255,255,0.85)",
          lineHeight: 1.4,
        }}>
          {killer.desc}
        </div>
      </div>
    </div>
  );
};

export const KillerFeaturePortrait: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleSpring = spring({
    frame,
    fps,
    config: { damping: 200, stiffness: 120 },
  });
  const titleY = interpolate(titleSpring, [0, 1], [-50, 0]);

  return (
    <AbsoluteFill style={{
      backgroundColor: "#06060e",
      justifyContent: "center",
      alignItems: "center",
      gap: 50,
      padding: 60,
    }}>
      <div style={{
        fontSize: 72,
        fontWeight: 900,
        color: "#ffffff",
        fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
        opacity: titleSpring,
        transform: `translateY(${titleY}px)`,
        textShadow: "0 0 40px rgba(168,85,247,0.8)",
        marginBottom: 20,
      }}>
        三大核心杀招
      </div>

      {KILLERS.map((k, i) => (
        <Card key={i} killer={k} delay={20 + i * 30} />
      ))}
    </AbsoluteFill>
  );
};
