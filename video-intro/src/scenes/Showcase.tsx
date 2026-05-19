import React, { useMemo } from "react";
import { useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import { ParticleBg } from "../components/ParticleBg";
import { NeonGrid } from "../components/NeonGrid";
import { GlowText } from "../components/GlowText";
import { Subtitle } from "../components/Subtitle";
import type { SubtitleItem } from "../components/Subtitle";

// ─── Part 1: Chat 对话模拟 ───────────────────────────────────────

/** 模拟对话消息 */
const CHAT_MESSAGES = [
  { role: "user", text: "帮我生成一个产品介绍视频" },
  { role: "system", text: "分析需求中..." },
  { role: "assistant", text: "已为您规划 7 个场景，分辨率 1920×1080，30fps。\n包含爆炸开场、能力展示、竞品对比、架构展示等模块。" },
  { role: "user", text: "加点科技感特效" },
  { role: "assistant", text: "好的。已添加 霓虹网格背景、矩阵粒子系统、\n色差文字效果、轨道粒子环、CRT扫描线覆盖。" },
] as const;

/** 计算到当前帧为止应显示的字符数 */
const getVisibleText = (text: string, charsRevealed: number) => {
  if (charsRevealed <= 0) return "";
  return text.slice(0, Math.min(charsRevealed, text.length));
};

/** 对话消息气泡 */
const ChatBubble: React.FC<{
  role: "user" | "assistant" | "system";
  text: string;
  visibleChars: number;
  isLast: boolean;
}> = ({ role, text, visibleChars, isLast }) => {
  const frame = useCurrentFrame();
  const isUser = role === "user";
  const isSystem = role === "system";

  const visible = getVisibleText(text, visibleChars);
  const cursorBlink = isLast && visibleChars >= text.length
    ? Math.sin(frame * 0.15) > -0.2
    : isLast && visibleChars < text.length;

  return (
    <div
      style={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
        marginBottom: 8,
        padding: "0 12px",
      }}
    >
      <div
        style={{
          maxWidth: "78%",
          padding: "8px 14px",
          borderRadius: 10,
          background: isUser
            ? "rgba(168,85,247,0.2)"
            : isSystem
            ? "rgba(100,100,120,0.15)"
            : "rgba(34,211,238,0.1)",
          border: `1px solid ${
            isUser
              ? "rgba(168,85,247,0.4)"
              : isSystem
              ? "rgba(100,100,120,0.25)"
              : "rgba(34,211,238,0.25)"
          }`,
          fontSize: 12,
          fontFamily: "'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
          color: isUser
            ? "rgba(255,255,255,0.85)"
            : isSystem
            ? "rgba(255,255,255,0.45)"
            : "rgba(255,255,255,0.75)",
          lineHeight: 1.7,
          whiteSpace: "pre-wrap",
          position: "relative",
        }}
      >
        <span style={{ opacity: isSystem ? 0.7 : 1 }}>
          {isUser && "👤 "}
          {isSystem && "⚙️ "}
          {isUser || isSystem ? "" : "🤖 "}
          {visible}
        </span>
        {cursorBlink && (
          <span
            style={{
              display: "inline-block",
              width: 1,
              height: 14,
              background: "#22d3ee",
              marginLeft: 2,
              verticalAlign: "text-bottom",
              boxShadow: "0 0 6px #22d3ee",
              opacity: cursorBlink ? 1 : 0,
            }}
          />
        )}
      </div>
    </div>
  );
};

/** 聊天窗口模拟 */
const ChatWindow: React.FC<{ inFrame: number }> = ({ inFrame }) => {
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();

  // 计算总打字进度
  const totalChars = CHAT_MESSAGES.reduce((sum, m) => sum + m.text.length, 0);
  const typingSpeed = 1.8; // 每秒显示字符数
  const charsRevealed = Math.floor(inFrame * typingSpeed);

  // 计算每条消息的显示进度
  let remaining = charsRevealed;
  const messageStates = CHAT_MESSAGES.map((m) => {
    const len = m.text.length;
    const chars = Math.max(0, Math.min(len, remaining));
    remaining -= len;
    return { ...m, visibleChars: chars };
  });

  // 窗口入场
  const windowEnter = spring({
    frame: Math.min(inFrame, 10),
    fps,
    config: { damping: 14, stiffness: 120 },
  });

  // 标题栏光点
  const titleDot = Math.sin(frame * 0.06) * 0.3 + 0.7;

  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        top: "50%",
        width: 580,
        height: 440,
        transform: `translate(-50%, -50%) scale(${interpolate(windowEnter, [0, 1], [0.5, 1], { extrapolateRight: "clamp" })})`,
        opacity: windowEnter,
        borderRadius: 12,
        overflow: "hidden",
        border: "1px solid rgba(168,85,247,0.3)",
        boxShadow: "0 0 40px rgba(168,85,247,0.15), 0 0 80px rgba(0,0,0,0.5)",
        background: "rgba(10,10,20,0.92)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* 标题栏 */}
      <div
        style={{
          height: 34,
          background: "rgba(168,85,247,0.15)",
          borderBottom: "1px solid rgba(168,85,247,0.25)",
          display: "flex",
          alignItems: "center",
          padding: "0 14px",
          gap: 8,
          flexShrink: 0,
        }}
      >
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: `rgba(34,211,238,${titleDot})`,
            boxShadow: `0 0 8px rgba(34,211,238,${titleDot * 0.7})`,
          }}
        />
        <span
          style={{
            fontSize: 11,
            fontFamily: "'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
            color: "rgba(255,255,255,0.5)",
            letterSpacing: "0.05em",
          }}
        >
          Super Loong · Chat
        </span>
        <div style={{ flex: 1 }} />
        <span
          style={{
            fontSize: 9,
            fontFamily: "'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
            color: "rgba(255,255,255,0.25)",
          }}
        >
          online
        </span>
      </div>

      {/* 消息区 */}
      <div
        style={{
          flex: 1,
          overflow: "hidden",
          padding: "10px 0",
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-end",
        }}
      >
        {messageStates.map((m, i) => (
          <ChatBubble
            key={i}
            role={m.role}
            text={m.text}
            visibleChars={m.visibleChars}
            isLast={i === messageStates.length - 1}
          />
        ))}
      </div>

      {/* 输入栏 */}
      <div
        style={{
          height: 30,
          borderTop: "1px solid rgba(168,85,247,0.12)",
          display: "flex",
          alignItems: "center",
          padding: "0 12px",
          gap: 8,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontFamily: "'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
            color: "rgba(255,255,255,0.2)",
          }}
        >
          Type a message...
        </span>
      </div>
    </div>
  );
};

// ─── Part 2: Diff 代码视图 ────────────────────────────────────────

/** 模拟 diff 行数据 */
const DIFF_LINES = [
  { type: "context", num: 1, text: "// 进化引擎核心调度" },
  { type: "context", num: 2, text: "class EvolutionEngine {" },
  { type: "add", num: 3, text: "+  private diffValidator: DiffValidator;" },
  { type: "add", num: 4, text: "+  private sandboxPool: SandboxPool;" },
  { type: "context", num: 5, text: "  private llmSelector: LLMSelector;" },
  { type: "remove", num: 6, text: "-  private legacyParser: LegacyParser;" },
  { type: "context", num: 7, text: "" },
  { type: "context", num: 8, text: "  async evolve(target: Module): Promise<Diff> {" },
  { type: "add", num: 9, text: "+    // 🔬 三级沙箱验证" },
  { type: "add", num: 10, text: "+    const testResult = await this.sandboxPool.run(diff);" },
  { type: "add", num: 11, text: "+    if (!testResult.passed) throw new SandboxError();" },
  { type: "context", num: 12, text: "" },
  { type: "context", num: 13, text: "    const patch = await this.generatePatch(target);" },
  { type: "remove", num: 14, text: "-    return legacyParser.apply(patch); // ❌ 旧逻辑" },
  { type: "add", num: 15, text: "+    return diffValidator.validateAndApply(patch);" },
  { type: "context", num: 16, text: "  }" },
  { type: "context", num: 17, text: "}" },
  { type: "add", num: 18, text: "+" },
  { type: "add", num: 19, text: "+// 34 模块覆盖 · 自动化审计 · 0 人工介入" },
  { type: "add", num: 20, text: "+// Stats: 成功 342, 回滚 12, 平均耗时 2.8s" },
];

/** Diff 视图 */
const DiffView: React.FC<{ inFrame: number }> = ({ inFrame }) => {
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();

  const enter = spring({
    frame: Math.min(inFrame, 12),
    fps,
    config: { damping: 14, stiffness: 120 },
  });

  // 行号滚动
  const lineHeight = 22;
  const visibleLines = 14;
  const maxScroll = Math.max(0, (DIFF_LINES.length - visibleLines) * lineHeight);
  const scrollY = interpolate(
    Math.max(0, inFrame - 20),
    [0, 90],
    [0, maxScroll],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        top: "50%",
        width: 620,
        height: 420,
        transform: `translate(-50%, -50%) scale(${interpolate(enter, [0, 1], [0.5, 1], { extrapolateRight: "clamp" })})`,
        opacity: enter,
        borderRadius: 12,
        overflow: "hidden",
        border: "1px solid rgba(249,115,22,0.3)",
        boxShadow: "0 0 40px rgba(249,115,22,0.12), 0 0 80px rgba(0,0,0,0.5)",
        background: "rgba(10,10,20,0.95)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* 标题栏 */}
      <div
        style={{
          height: 34,
          background: "rgba(249,115,22,0.12)",
          borderBottom: "1px solid rgba(249,115,22,0.2)",
          display: "flex",
          alignItems: "center",
          padding: "0 14px",
          gap: 8,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontFamily: "'Cascadia Code', Consolas, 'Courier New', monospace",
            color: "rgba(255,255,255,0.5)",
            letterSpacing: "0.05em",
          }}
        >
          △ diff/evolution-engine.ts
        </span>
        <div style={{ flex: 1 }} />
        <span
          style={{
            fontSize: 9,
            fontFamily: "'Cascadia Code', Consolas, 'Courier New', monospace",
            color: "rgba(74,222,128,0.7)",
          }}
        >
          +12 −2
        </span>
      </div>

      {/* 代码区 */}
      <div
        style={{
          flex: 1,
          overflow: "hidden",
          position: "relative",
          padding: "4px 0",
        }}
      >
        <div
          style={{
            transform: `translateY(${-scrollY}px)`,
          }}
        >
          {DIFF_LINES.map((line, i) => {
            const bgColor =
              line.type === "add"
                ? "rgba(74,222,128,0.08)"
                : line.type === "remove"
                ? "rgba(248,113,113,0.08)"
                : "transparent";

            const textColor =
              line.type === "add"
                ? "rgba(74,222,128,0.9)"
                : line.type === "remove"
                ? "rgba(248,113,113,0.7)"
                : "rgba(255,255,255,0.55)";

            return (
              <div
                key={i}
                style={{
                  display: "flex",
                  height: lineHeight,
                  alignItems: "center",
                  background: bgColor,
                  fontFamily: "Consolas, 'Courier New', 'Microsoft YaHei', monospace",
                  fontSize: 12,
                  lineHeight: `${lineHeight}px`,
                  borderLeft: line.type === "add"
                    ? "2px solid rgba(74,222,128,0.4)"
                    : line.type === "remove"
                    ? "2px solid rgba(248,113,113,0.4)"
                    : "2px solid transparent",
                }}
              >
                {/* 行号 */}
                <span
                  style={{
                    width: 40,
                    textAlign: "right",
                    paddingRight: 10,
                    color: "rgba(255,255,255,0.15)",
                    fontSize: 10,
                    flexShrink: 0,
                    userSelect: "none",
                  }}
                >
                  {line.num}
                </span>
                {/* 代码内容 */}
                <span
                  style={{
                    color: textColor,
                    whiteSpace: "pre",
                  }}
                >
                  {line.text}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

// ─── Showcase 主场景 ──────────────────────────────────────────────

/** 场景: UI 效果展示 39.33-47.67s (250f) */
export const Showcase: React.FC<{ subtitles: SubtitleItem[] }> = ({
  subtitles,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleSpring = spring({
    frame,
    fps,
    config: { damping: 200, stiffness: 120 },
  });

  const isPart2 = frame >= 120;

  return (
    <div style={{ flex: 1, position: "relative", width: "100%", height: "100%" }}>
      <NeonGrid color="#22d3ee" opacity={0.05} />
      <ParticleBg count={30} intensity="low" />

      {/* 主内容 zIndex:10 */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 10,
        }}
      >
        {/* 标题 */}
        <div
          style={{
            textAlign: "center",
            paddingTop: 24,
            opacity: titleSpring,
          }}
        >
          <GlowText
            text={isPart2 ? "进化引擎 · 实时 Diff" : "智能对话 · 一句话出片"}
            fontSize={38}
            color="#ffffff"
            glowColor={isPart2 ? "#f97316" : "#a855f7"}
            delay={isPart2 ? 0 : 0}
          />
        </div>

        {/* Part 1: 聊天窗口 (0-120f) / Part 2: Diff视图 (120-250f) */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            opacity: isPart2
              ? interpolate(frame, [120, 130], [1, 1], { extrapolateRight: "clamp" })
              : interpolate(frame, [110, 120], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          }}
        >
          {!isPart2 ? (
            <ChatWindow inFrame={frame} />
          ) : (
            <DiffView inFrame={frame - 120} />
          )}
        </div>
      </div>

      <Subtitle items={subtitles} />
    </div>
  );
};
