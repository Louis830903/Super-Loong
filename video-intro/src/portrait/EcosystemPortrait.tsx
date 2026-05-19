import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";

/**
 * 竖屏 - 完整智能生态（240f / 8s）
 * 五大支柱（口径锺定 README）：
 * - 专家 211 / 16 行业
 * - 进化引擎 34 模块
 * - HRR 全息相位记忆
 * - MCP 生态 stdio/SSE/HTTP
 * - 知识库 10+ 格式 BM25+向量
 */

const PILLARS = [
  {
    icon: "🧠",
    title: "专家 Agent",
    metric: "211",
    desc: "16 行业 · 智能分配",
    color: "#a855f7",
    big: true,
  },
  {
    icon: "🧬",
    title: "进化引擎",
    metric: "34",
    desc: "模块 · 源码级自修改",
    color: "#3b82f6",
    big: true,
  },
  {
    icon: "🔮",
    title: "HRR 记忆",
    metric: "相位",
    desc: "绑定/解绑运算",
    color: "#ec4899",
    big: false,
  },
  {
    icon: "🔧",
    title: "MCP 生态",
    metric: "3传",
    desc: "stdio/SSE/HTTP",
    color: "#10b981",
    big: false,
  },
  {
    icon: "📚",
    title: "知识库",
    metric: "10+",
    desc: "格式 · BM25+向量",
    color: "#f97316",
    big: false,
  },
];

export const EcosystemPortrait: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleSpring = spring({ frame, fps, config: { damping: 200, stiffness: 100 } });
  const titleY = interpolate(titleSpring, [0, 1], [-40, 0]);

  const subSpring = spring({
    frame: Math.max(0, frame - 18),
    fps,
    config: { damping: 200, stiffness: 100 },
  });

  const taglineSpring = spring({
    frame: Math.max(0, frame - 200),
    fps,
    config: { damping: 200, stiffness: 100 },
  });

  // 顶部数据条脉动
  const pulse = Math.sin(frame * 0.08) * 0.15 + 0.85;

  return (
    <AbsoluteFill style={{
      backgroundColor: "#06060e",
      background: "radial-gradient(ellipse at 50% 50%, rgba(59,130,246,0.12) 0%, #06060e 70%)",
    }}>
      <div style={{
        position: "absolute", inset: 0, zIndex: 10,
        display: "flex", flexDirection: "column",
        justifyContent: "center", alignItems: "center",
        padding: "100px 50px",
      }}>
        {/* 标题 */}
        <div style={{
          fontSize: 84,
          fontWeight: 900,
          color: "#ffffff",
          letterSpacing: "0.06em",
          textAlign: "center",
          fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
          opacity: titleSpring,
          transform: `translateY(${titleY}px)`,
          textShadow: "0 0 40px rgba(59,130,246,0.7)",
        }}>
          完整智能生态
        </div>

        <div style={{
          marginTop: 20,
          fontSize: 38,
          color: "#3b82f6",
          letterSpacing: "0.14em",
          fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
          opacity: subSpring,
          textAlign: "center",
          textShadow: `0 0 ${20 * pulse}px rgba(59,130,246,0.6)`,
        }}>
          专家 · 进化 · 记忆 · MCP · 知识
        </div>

        {/* 大卡片：工具 + Agent */}
        <div style={{
          marginTop: 50,
          display: "flex",
          gap: 22,
          width: "100%",
        }}>
          {PILLARS.filter(p => p.big).map((p, i) => {
            const delay = 35 + i * 22;
            const cardSpring = spring({
              frame: Math.max(0, frame - delay),
              fps,
              config: { damping: 200, stiffness: 100 },
            });
            const cardScale = interpolate(cardSpring, [0, 1], [0.5, 1]);

            return (
              <div key={i} style={{
                flex: 1,
                padding: "32px 20px 28px",
                borderRadius: 32,
                background: `linear-gradient(160deg, ${p.color}3a 0%, ${p.color}10 100%)`,
                border: `2px solid ${p.color}88`,
                boxShadow: `0 0 50px ${p.color}44`,
                opacity: cardSpring,
                transform: `scale(${cardScale})`,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                textAlign: "center",
              }}>
                <div style={{
                  fontSize: 96,
                  marginBottom: 8,
                  filter: `drop-shadow(0 0 24px ${p.color})`,
                }}>
                  {p.icon}
                </div>
                <div style={{
                  fontSize: 100,
                  fontWeight: 900,
                  color: p.color,
                  fontFamily: "monospace",
                  textShadow: `0 0 28px ${p.color}`,
                  lineHeight: 1,
                }}>
                  {p.metric}
                </div>
                <div style={{
                  marginTop: 14,
                  fontSize: 42,
                  fontWeight: 900,
                  color: "#ffffff",
                  fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
                  letterSpacing: "0.04em",
                }}>
                  {p.title}
                </div>
                <div style={{
                  marginTop: 6,
                  fontSize: 22,
                  color: "rgba(255,255,255,0.55)",
                  fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
                  letterSpacing: "0.08em",
                }}>
                  {p.desc}
                </div>
              </div>
            );
          })}
        </div>

        {/* 三个小卡片 */}
        <div style={{
          marginTop: 24,
          display: "flex",
          gap: 16,
          width: "100%",
        }}>
          {PILLARS.filter(p => !p.big).map((p, i) => {
            const delay = 90 + i * 18;
            const cardSpring = spring({
              frame: Math.max(0, frame - delay),
              fps,
              config: { damping: 200, stiffness: 110 },
            });
            const cardY = interpolate(cardSpring, [0, 1], [40, 0]);

            return (
              <div key={i} style={{
                flex: 1,
                padding: "24px 12px 20px",
                borderRadius: 24,
                background: `linear-gradient(160deg, ${p.color}30 0%, ${p.color}08 100%)`,
                border: `2px solid ${p.color}66`,
                boxShadow: `0 0 28px ${p.color}33`,
                opacity: cardSpring,
                transform: `translateY(${cardY}px)`,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                textAlign: "center",
              }}>
                <div style={{
                  fontSize: 64,
                  marginBottom: 6,
                  filter: `drop-shadow(0 0 16px ${p.color})`,
                }}>
                  {p.icon}
                </div>
                <div style={{
                  fontSize: 30,
                  fontWeight: 900,
                  color: "#ffffff",
                  fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
                }}>
                  {p.title}
                </div>
                <div style={{
                  marginTop: 4,
                  fontSize: 28,
                  fontWeight: 900,
                  color: p.color,
                  fontFamily: "monospace",
                  textShadow: `0 0 12px ${p.color}88`,
                }}>
                  {p.metric}
                </div>
                <div style={{
                  marginTop: 6,
                  fontSize: 18,
                  color: "rgba(255,255,255,0.5)",
                  fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
                  letterSpacing: "0.04em",
                }}>
                  {p.desc}
                </div>
              </div>
            );
          })}
        </div>

        {/* 底部 tagline */}
        <div style={{
          marginTop: 50,
          fontSize: 38,
          color: "rgba(255,255,255,0.85)",
          letterSpacing: "0.18em",
          textAlign: "center",
          fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
          opacity: taglineSpring,
          textShadow: "0 0 20px rgba(59,130,246,0.5)",
        }}>
          开箱即用 · 持续进化
        </div>
      </div>
    </AbsoluteFill>
  );
};
