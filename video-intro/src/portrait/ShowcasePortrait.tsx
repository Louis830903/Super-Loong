import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";

/**
 * 竖屏 Showcase（180f / 6s）
 * 模拟手机聊天界面，展示"一句话出片"
 */
const MESSAGES = [
  { from: "user", text: "帮我做个 60 秒产品介绍视频", delay: 10 },
  { from: "ai", text: "✓ 分析需求\n✓ 生成脚本\n✓ 渲染场景\n→ 视频已生成", delay: 50 },
];

export const ShowcasePortrait: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleSpring = spring({
    frame,
    fps,
    config: { damping: 200, stiffness: 120 },
  });

  return (
    <AbsoluteFill style={{
      backgroundColor: "#06060e",
      justifyContent: "center",
      alignItems: "center",
      padding: 60,
    }}>
      {/* 标题 */}
      <div style={{
        fontSize: 72,
        fontWeight: 900,
        color: "#ffffff",
        fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
        opacity: titleSpring,
        textShadow: "0 0 40px rgba(168,85,247,0.8)",
        marginBottom: 20,
      }}>
        一句话出片
      </div>
      <div style={{
        fontSize: 38,
        color: "rgba(255,255,255,0.7)",
        fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
        opacity: titleSpring,
        marginBottom: 60,
      }}>
        AI 自动拆解 · 全流程交付
      </div>

      {/* 聊天卡片 */}
      <div style={{
        width: 880,
        background: "rgba(255,255,255,0.04)",
        border: "2px solid rgba(168,85,247,0.4)",
        borderRadius: 32,
        padding: 40,
        boxShadow: "0 0 60px rgba(168,85,247,0.4)",
      }}>
        {/* 标题栏 */}
        <div style={{
          fontSize: 36,
          fontWeight: 700,
          color: "#a855f7",
          marginBottom: 30,
          paddingBottom: 20,
          borderBottom: "1px solid rgba(255,255,255,0.1)",
          fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
        }}>
          🐉 Super Loong · Chat
        </div>

        {MESSAGES.map((msg, i) => {
          const enter = spring({
            frame: Math.max(0, frame - msg.delay),
            fps,
            config: { damping: 200, stiffness: 100 },
          });
          const isUser = msg.from === "user";
          const x = interpolate(enter, [0, 1], [isUser ? 200 : -200, 0]);

          return (
            <div key={i} style={{
              display: "flex",
              justifyContent: isUser ? "flex-end" : "flex-start",
              marginTop: i === 0 ? 0 : 32,
              opacity: enter,
              transform: `translateX(${x}px)`,
            }}>
              <div style={{
                maxWidth: 700,
                padding: "28px 36px",
                borderRadius: 24,
                background: isUser
                  ? "linear-gradient(135deg, #a855f7, #6d28d9)"
                  : "rgba(255,255,255,0.08)",
                border: isUser ? "none" : "1px solid rgba(255,255,255,0.15)",
                color: "#ffffff",
                fontSize: 36,
                lineHeight: 1.5,
                whiteSpace: "pre-line",
                fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
                fontWeight: isUser ? 600 : 400,
              }}>
                {msg.text}
              </div>
            </div>
          );
        })}
      </div>

      {/* 视频成品标签 */}
      <div style={{
        marginTop: 50,
        padding: "20px 50px",
        borderRadius: 100,
        background: "linear-gradient(90deg, #10b981, #059669)",
        color: "#ffffff",
        fontSize: 40,
        fontWeight: 900,
        letterSpacing: "0.05em",
        fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
        boxShadow: "0 0 50px rgba(16,185,129,0.6)",
        opacity: spring({ frame: Math.max(0, frame - 110), fps, config: { damping: 200, stiffness: 90 } }),
      }}>
        🎬 视频生成完成 · 60s
      </div>
    </AbsoluteFill>
  );
};
