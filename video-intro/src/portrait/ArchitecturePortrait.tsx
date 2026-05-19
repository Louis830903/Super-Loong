import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import { OrbitalRing } from "../components/OrbitalRing";

/**
 * 竖屏 Architecture（180f / 6s）
 * 自我进化引擎可视化：中心核 + 旋转环 + 4个能力点
 */
// 进化引擎四方位（呼应 README 34 模块 · 源码级自修改）：
// 感知 → 推理 → 执行 → 自修改（diff 对比 + 沙箱验证 + 人工审批闭环）
const PILLARS = [
  { name: "感知", angle: 0, color: "#a855f7" },
  { name: "推理", angle: 90, color: "#3b82f6" },
  { name: "执行", angle: 180, color: "#10b981" },
  { name: "自修改", angle: 270, color: "#f59e0b" },
];

export const ArchitecturePortrait: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleSpring = spring({
    frame,
    fps,
    config: { damping: 200, stiffness: 120 },
  });

  const coreScale = spring({
    frame: Math.max(0, frame - 20),
    fps,
    config: { damping: 100, stiffness: 80 },
  });

  const corePulse = Math.sin(frame * 0.08) * 0.06 + 1;

  return (
    <AbsoluteFill style={{
      backgroundColor: "#06060e",
      justifyContent: "center",
      alignItems: "center",
    }}>
      {/* 标题 */}
      <div style={{
        position: "absolute",
        top: 200,
        fontSize: 72,
        fontWeight: 900,
        color: "#ffffff",
        fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
        opacity: titleSpring,
        textShadow: "0 0 40px rgba(168,85,247,0.8)",
      }}>
        自我进化引擎
      </div>

      {/* 副标题 */}
      <div style={{
        position: "absolute",
        top: 310,
        fontSize: 38,
        color: "rgba(255,255,255,0.7)",
        letterSpacing: "0.1em",
        fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
        opacity: titleSpring,
      }}>
34 模块 · 源码级自修改 · 沙箱验证
      </div>

      {/* 中心引擎核 */}
      <div style={{
        position: "relative",
        width: 900,
        height: 900,
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
      }}>
        {/* 三层旋转环 */}
        <div style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)" }}>
          <OrbitalRing size={840} color="#a855f7" particleCount={10} ringOpacity={0.5} />
        </div>
        <div style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)" }}>
          <OrbitalRing size={620} color="#3b82f6" particleCount={8} ringOpacity={0.4} />
        </div>
        <div style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)" }}>
          <OrbitalRing size={420} color="#10b981" particleCount={6} ringOpacity={0.4} />
        </div>

        {/* 中心核 */}
        <div style={{
          width: 220,
          height: 220,
          borderRadius: "50%",
          background: "radial-gradient(circle, #a855f7 0%, #6d28d9 60%, transparent 100%)",
          boxShadow: "0 0 100px #a855f7, 0 0 200px #6d28d9",
          transform: `scale(${coreScale * corePulse})`,
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          fontSize: 90,
        }}>
          🧠
        </div>

        {/* 四方位能力点 */}
        {PILLARS.map((p, i) => {
          const enter = spring({
            frame: Math.max(0, frame - 40 - i * 12),
            fps,
            config: { damping: 200, stiffness: 100 },
          });
          const rad = (p.angle * Math.PI) / 180;
          const r = 420;
          const x = Math.cos(rad) * r;
          const y = Math.sin(rad) * r;
          return (
            <div key={i} style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              transform: `translate(${x - 55}px, ${y - 55}px) scale(${enter})`,
              width: 110,
              height: 110,
              borderRadius: "50%",
              background: `radial-gradient(circle, ${p.color}, ${p.color}66)`,
              boxShadow: `0 0 50px ${p.color}`,
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              color: "#ffffff",
              fontSize: 34,
              fontWeight: 900,
              fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
              opacity: enter,
            }}>
              {p.name}
            </div>
          );
        })}
      </div>

      {/* 底部小字 */}
      <div style={{
        position: "absolute",
        bottom: 240,
        fontSize: 36,
        color: "#a855f7",
        letterSpacing: "0.15em",
        fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
        opacity: titleSpring,
      }}>
Agent 写代码改自己
      </div>
    </AbsoluteFill>
  );
};
