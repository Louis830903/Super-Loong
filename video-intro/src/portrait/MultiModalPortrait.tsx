import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";

/**
 * 竖屏 - 多模态全能（210f / 7s）
 * "看 · 听 · 说 · 画" — 视觉 / 语音 / 文本 / 视觉生成四象限
 * 口径锺定：桌面 OCR、阿里云 STT/TTS、多 LLM 厂商、ComfyUI + RunningHub
 */

const MODALITIES = [
  {
    icon: "👁️",
    title: "视觉理解",
    sub: "图像 · 桌面 OCR",
    metric: "截屏",
    metricLabel: "看懂屏幕",
    color: "#a855f7",
  },
  {
    icon: "🎙️",
    title: "语音对话",
    sub: "STT · TTS · 实时",
    metric: "阿里云",
    metricLabel: "原生集成",
    color: "#22d3ee",
  },
  {
    icon: "✍️",
    title: "文本生成",
    sub: "写作 · 翻译 · 编码",
    metric: "多 LLM",
    metricLabel: "一键切换",
    color: "#10b981",
  },
  {
    icon: "🎬",
    title: "视频生成",
    sub: "脚本 · 出片 · BGM",
    metric: "ComfyUI",
    metricLabel: "+ RunningHub",
    color: "#f97316",
  },
];

export const MultiModalPortrait: React.FC = () => {
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
    frame: Math.max(0, frame - 175),
    fps,
    config: { damping: 200, stiffness: 100 },
  });

  return (
    <AbsoluteFill style={{
      backgroundColor: "#06060e",
      background: "radial-gradient(ellipse at 50% 40%, rgba(168,85,247,0.12) 0%, #06060e 65%)",
    }}>
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
          textShadow: "0 0 40px rgba(168,85,247,0.7)",
        }}>
          多模态全能
        </div>

        <div style={{
          marginTop: 24,
          fontSize: 42,
          color: "#a855f7",
          letterSpacing: "0.16em",
          fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
          opacity: subSpring,
          textAlign: "center",
        }}>
          看 · 听 · 说 · 画
        </div>

        {/* 2x2 网格 */}
        <div style={{
          marginTop: 70,
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 28,
          width: "100%",
        }}>
          {MODALITIES.map((m, i) => {
            const delay = 40 + i * 24;
            const cardSpring = spring({
              frame: Math.max(0, frame - delay),
              fps,
              config: { damping: 200, stiffness: 100 },
            });
            const cardScale = interpolate(cardSpring, [0, 1], [0.5, 1]);

            return (
              <div key={i} style={{
                padding: "36px 28px",
                borderRadius: 32,
                background: `linear-gradient(160deg, ${m.color}33 0%, ${m.color}0d 100%)`,
                border: `2px solid ${m.color}66`,
                boxShadow: `0 0 40px ${m.color}33`,
                opacity: cardSpring,
                transform: `scale(${cardScale})`,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                textAlign: "center",
              }}>
                <div style={{
                  fontSize: 92,
                  marginBottom: 12,
                  filter: `drop-shadow(0 0 20px ${m.color})`,
                }}>
                  {m.icon}
                </div>
                <div style={{
                  fontSize: 44,
                  fontWeight: 900,
                  color: "#ffffff",
                  fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
                  letterSpacing: "0.04em",
                  textShadow: `0 0 16px ${m.color}88`,
                }}>
                  {m.title}
                </div>
                <div style={{
                  marginTop: 6,
                  fontSize: 22,
                  color: "rgba(255,255,255,0.55)",
                  fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
                  letterSpacing: "0.08em",
                }}>
                  {m.sub}
                </div>
                <div style={{
                  marginTop: 18,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                }}>
                  <div style={{
                    fontSize: 56,
                    fontWeight: 900,
                    color: m.color,
                    fontFamily: "monospace",
                    textShadow: `0 0 24px ${m.color}`,
                  }}>
                    {m.metric}
                  </div>
                  <div style={{
                    fontSize: 22,
                    color: "rgba(255,255,255,0.7)",
                    fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
                    letterSpacing: "0.1em",
                    marginTop: 2,
                  }}>
                    {m.metricLabel}
                  </div>
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
          textShadow: "0 0 20px rgba(168,85,247,0.5)",
        }}>
          输入输出 · 不止文字
        </div>
      </div>
    </AbsoluteFill>
  );
};
