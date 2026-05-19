import React from "react";
import { AbsoluteFill } from "remotion";
import {
  TransitionSeries,
  linearTiming,
} from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { wipe } from "@remotion/transitions/wipe";
import { flip } from "@remotion/transitions/flip";

import { Opening } from "./scenes/Opening";
import { Features } from "./scenes/Features";
import { KillerFeature } from "./scenes/KillerFeature";
import { Comparison } from "./scenes/Comparison";
import { Architecture } from "./scenes/Architecture";
import { Showcase } from "./scenes/Showcase";
import { Outro } from "./scenes/Outro";

import { ScanLine } from "./components/ScanLine";

import { openingSubtitles } from "./data/subtitles/Opening";
import { featuresSubtitles } from "./data/subtitles/Features";
import { killerFeatureSubtitles } from "./data/subtitles/KillerFeature";
import { comparisonSubtitles } from "./data/subtitles/Comparison";
import { architectureSubtitles } from "./data/subtitles/Architecture";
import { showcaseSubtitles } from "./data/subtitles/Showcase";
import { outroSubtitles } from "./data/subtitles/Outro";

/**
 * 主时间线 — 7 场景 + 6 过渡
 *
 * TransitionSeries 的过渡会导致场景重叠，总时长 = sum(seq) - sum(trans)
 * 目标总时长 1800f，6 个过渡各 10f = 60f 重叠
 * sum(seq) = 150+230+320+290+220+280+370 = 1860，total = 1860-60 = 1800 ✓
 */
export const SuperAgentIntro: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#06060e" }}>
      <TransitionSeries>
        {/* 1. Opening: 爆炸开场 (150f) */}
        <TransitionSeries.Sequence durationInFrames={150}>
          <Opening subtitles={openingSubtitles} />
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition
          timing={linearTiming({ durationInFrames: 10 })}
          presentation={fade()}
        />

        {/* 2. Features: 8大能力轮播 (230f) */}
        <TransitionSeries.Sequence durationInFrames={230}>
          <Features subtitles={featuresSubtitles} />
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition
          timing={linearTiming({ durationInFrames: 10 })}
          presentation={wipe({ direction: "from-left" })}
        />

        {/* 3. KillerFeature: 三大杀招 (320f) */}
        <TransitionSeries.Sequence durationInFrames={320}>
          <KillerFeature subtitles={killerFeatureSubtitles} />
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition
          timing={linearTiming({ durationInFrames: 10 })}
          presentation={flip({ direction: "from-right" })}
        />

        {/* 4. Comparison: 竞品对比 (290f) */}
        <TransitionSeries.Sequence durationInFrames={290}>
          <Comparison subtitles={comparisonSubtitles} />
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition
          timing={linearTiming({ durationInFrames: 10 })}
          presentation={fade()}
        />

        {/* 5. Architecture: 技术架构 (220f) */}
        <TransitionSeries.Sequence durationInFrames={220}>
          <Architecture subtitles={architectureSubtitles} />
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition
          timing={linearTiming({ durationInFrames: 10 })}
          presentation={wipe({ direction: "from-left" })}
        />

        {/* 6. Showcase: UI效果展示 (280f) */}
        <TransitionSeries.Sequence durationInFrames={280}>
          <Showcase subtitles={showcaseSubtitles} />
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition
          timing={linearTiming({ durationInFrames: 10 })}
          presentation={fade()}
        />

        {/* 7. Outro: CTA 总攻 (370f) */}
        <TransitionSeries.Sequence durationInFrames={370}>
          <Outro subtitles={outroSubtitles} />
        </TransitionSeries.Sequence>
      </TransitionSeries>

      {/* 全局 CRT 扫描线覆盖 zIndex:9999 */}
      <ScanLine opacity={0.04} />
    </AbsoluteFill>
  );
};
