import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";

/**
 * 竖屏 - 三大平台 IM 接入（210f / 7s）
 * "一套代码 · 三平台复用" — 飞书 / 钉钉 / 企业微信
 * 插件式热插拔架构，钉钉已升级 OAuth 2.0 新 API
 */

const CHANNELS = [
  { name: "飞书", emoji: "🪶", desc: "Feishu / Lark", tag: "消息·卡片·文件全支持", color: "#22d3ee" },
  { name: "钉钉", emoji: "📘", desc: "DingTalk", tag: "OAuth 2.0 新 API 升级完成", color: "#3b82f6" },
  { name: "企业微信", emoji: "💬", desc: "WeCom", tag: "消息收发 · 群机器人", color: "#10b981" },
];

export const MultiChannelPortrait: React.FC = () => {
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
    frame: Math.max(0, frame - 170),
    fps,
    config: { damping: 200, stiffness: 100 },
  });

  return (
    <AbsoluteFill style={{
      backgroundColor: "#06060e",
      background: "radial-gradient(ellipse at 50% 30%, rgba(34,211,238,0.12) 0%, #06060e 65%)",
    }}>
      {/* 主内容层 */}
      <div style={{
        position: "absolute", inset: 0, zIndex: 10,
        display: "flex", flexDirection: "column",
        justifyContent: "center", alignItems: "center",
        padding: "100px 60px",
      }}>
        {/* 标题 */}
        <div style={{
          fontSize: 88,
          fontWeight: 900,
          color: "#ffffff",
          letterSpacing: "0.08em",
          textAlign: "center",
          fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
          opacity: titleSpring,
          transform: `translateY(${titleY}px)`,
          textShadow: "0 0 40px rgba(34,211,238,0.7)",
        }}>
          三大平台 IM
        </div>

        <div style={{
          marginTop: 24,
          fontSize: 42,
          color: "#22d3ee",
          letterSpacing: "0.16em",
          fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
          opacity: subSpring,
          textAlign: "center",
        }}>
          插件式热插拔 · 一套代码走通
        </div>

        {/* 通道矩阵 — 3 张大卡面纵向堆叠 */}
        <div style={{
          marginTop: 80,
          display: "flex",
          flexDirection: "column",
          gap: 32,
          width: "100%",
        }}>
          {CHANNELS.map((c, i) => {
            const delay = 40 + i * 26;
            const cardSpring = spring({
              frame: Math.max(0, frame - delay),
              fps,
              config: { damping: 200, stiffness: 110 },
            });
            const cardX = interpolate(cardSpring, [0, 1], [i % 2 === 0 ? -120 : 120, 0]);

            return (
              <div key={i} style={{
                display: "flex",
                alignItems: "center",
                gap: 32,
                padding: "36px 44px",
                borderRadius: 32,
                background: `linear-gradient(135deg, ${c.color}3a 0%, ${c.color}10 100%)`,
                border: `2px solid ${c.color}88`,
                boxShadow: `0 0 40px ${c.color}44`,
                opacity: cardSpring,
                transform: `translateX(${cardX}px)`,
              }}>
                <div style={{
                  fontSize: 96,
                  width: 130,
                  height: 130,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 28,
                  background: `${c.color}26`,
                  flexShrink: 0,
                }}>
                  {c.emoji}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 16,
                    flexWrap: "wrap",
                  }}>
                    <div style={{
                      fontSize: 64,
                      fontWeight: 900,
                      color: "#ffffff",
                      fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
                      letterSpacing: "0.04em",
                    }}>
                      {c.name}
                    </div>
                    <div style={{
                      fontSize: 26,
                      color: "rgba(255,255,255,0.5)",
                      fontFamily: "monospace",
                      letterSpacing: "0.06em",
                    }}>
                      {c.desc}
                    </div>
                  </div>
                  <div style={{
                    marginTop: 8,
                    fontSize: 28,
                    color: "rgba(255,255,255,0.78)",
                    fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
                    letterSpacing: "0.04em",
                  }}>
                    {c.tag}
                  </div>
                </div>
                {/* 在线指示灯 */}
                <div style={{
                  width: 22, height: 22, borderRadius: "50%",
                  background: c.color,
                  boxShadow: `0 0 20px ${c.color}, 0 0 40px ${c.color}88`,
                }} />
              </div>
            );
          })}
        </div>

        {/* 底部 tagline */}
        <div style={{
          marginTop: 60,
          fontSize: 38,
          color: "rgba(255,255,255,0.85)",
          letterSpacing: "0.18em",
          textAlign: "center",
          fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
          opacity: taglineSpring,
          textShadow: "0 0 20px rgba(34,211,238,0.5)",
        }}>
          消息格式自动适配 · 渠道零耦合
        </div>
      </div>
    </AbsoluteFill>
  );
};
