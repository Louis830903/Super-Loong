import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";

/**
 * 动画柱状图 — 从 0 生长到目标值
 * 支持多色、标签、数字计数器
 * 注意：不包含 CSS transition，完全由 Remotion 帧驱动
 */
export const DataBar: React.FC<{
  value: number;
  maxValue: number;
  label: string;
  color?: string;
  delay?: number;
  width?: number;
  height?: number;
  showValue?: boolean;
  suffix?: string;
}> = ({
  value,
  maxValue,
  label,
  color = "#a855f7",
  delay = 0,
  width = 60,
  height = 160,
  showValue = true,
  suffix = "",
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const entrance = spring({
    frame: Math.max(0, frame - delay),
    fps,
    config: { damping: 14, stiffness: 120 },
  });

  const barHeight = interpolate(entrance, [0, 1], [0, (value / maxValue) * height], {
    extrapolateRight: "clamp",
  });
  const displayVal = interpolate(entrance, [0, 1], [0, value], {
    extrapolateRight: "clamp",
  });
  const glow = Math.sin(frame * 0.04 + delay * 0.1) * 0.3 + 0.7;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        opacity: entrance,
      }}
    >
      {/* 数值标签 */}
      {showValue && (
        <div
          style={{
            fontSize: 18,
            fontWeight: 800,
            color,
            fontFamily: "monospace",
            textShadow: `0 0 12px ${color}`,
          }}
        >
          {Math.floor(displayVal)}{suffix}
        </div>
      )}

      {/* 柱状图容器 */}
      <div
        style={{
          width,
          height,
          borderRadius: 6,
          background: "rgba(255,255,255,0.03)",
          border: `1px solid ${color}22`,
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {/* 生长柱 — Remotion 帧驱动，无 CSS transition */}
        <div
          style={{
            width: width - 12,
            height: barHeight,
            borderRadius: "4px 4px 0 0",
            background: `linear-gradient(to top, ${color}88, ${color})`,
            boxShadow: `0 0 ${20 * glow}px ${color}, 0 0 ${40 * glow}px ${color}44, inset 0 2px 0 rgba(255,255,255,0.2)`,
          }}
        />
      </div>

      {/* 底部标签 */}
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: "rgba(255,255,255,0.4)",
          letterSpacing: "0.04em",
        }}
      >
        {label}
      </div>
    </div>
  );
};
