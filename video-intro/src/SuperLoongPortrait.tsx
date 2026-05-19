import React from "react";
import { AbsoluteFill } from "remotion";
import {
  TransitionSeries,
  linearTiming,
} from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { wipe } from "@remotion/transitions/wipe";
import { slide } from "@remotion/transitions/slide";

import { OpeningPortrait } from "./portrait/OpeningPortrait";
import { KillerFeaturePortrait } from "./portrait/KillerFeaturePortrait";
import { MultiChannelPortrait } from "./portrait/MultiChannelPortrait";
import { MultiModalPortrait } from "./portrait/MultiModalPortrait";
import { ArchitecturePortrait } from "./portrait/ArchitecturePortrait";
import { EcosystemPortrait } from "./portrait/EcosystemPortrait";
import { ShowcasePortrait } from "./portrait/ShowcasePortrait";
import { OutroPortrait } from "./portrait/OutroPortrait";
import { ScanLine } from "./components/ScanLine";

/**
 * 竖屏 60s 完整版（1080×1920，1800 帧 @ 30fps）
 * 视频号 / 抖音 / B 站 / 小红书 / 官网首页
 *
 * 场景帧分配（7 过渡各 10f 重叠）：
 * sum(seq) = 210+280+210+210+260+240+240+220 = 1870
 * total    = 1870 - 70 = 1800 ✓
 */
export const SuperLoongPortrait: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#06060e" }}>
      <TransitionSeries>
        {/* 1. Opening 7s：品牌 + 核心数据 */}
        <TransitionSeries.Sequence durationInFrames={210}>
          <OpeningPortrait />
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition
          timing={linearTiming({ durationInFrames: 10 })}
          presentation={fade()}
        />

        {/* 2. KillerFeature ~9.3s：三大核心杀招 */}
        <TransitionSeries.Sequence durationInFrames={280}>
          <KillerFeaturePortrait />
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition
          timing={linearTiming({ durationInFrames: 10 })}
          presentation={wipe({ direction: "from-left" })}
        />

        {/* 3. MultiChannel 7s：全通道 IM 接入 */}
        <TransitionSeries.Sequence durationInFrames={210}>
          <MultiChannelPortrait />
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition
          timing={linearTiming({ durationInFrames: 10 })}
          presentation={slide({ direction: "from-right" })}
        />

        {/* 4. MultiModal 7s：多模态能力 */}
        <TransitionSeries.Sequence durationInFrames={210}>
          <MultiModalPortrait />
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition
          timing={linearTiming({ durationInFrames: 10 })}
          presentation={fade()}
        />

        {/* 5. Architecture ~8.7s：自我进化引擎闭环 */}
        <TransitionSeries.Sequence durationInFrames={260}>
          <ArchitecturePortrait />
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition
          timing={linearTiming({ durationInFrames: 10 })}
          presentation={fade()}
        />

        {/* 6. Ecosystem 8s：完整智能生态 */}
        <TransitionSeries.Sequence durationInFrames={240}>
          <EcosystemPortrait />
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition
          timing={linearTiming({ durationInFrames: 10 })}
          presentation={wipe({ direction: "from-bottom" })}
        />

        {/* 7. Showcase 8s：一句话出片实拍动画 */}
        <TransitionSeries.Sequence durationInFrames={240}>
          <ShowcasePortrait />
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition
          timing={linearTiming({ durationInFrames: 10 })}
          presentation={fade()}
        />

        {/* 8. Outro ~7.3s：CTA 收尾 */}
        <TransitionSeries.Sequence durationInFrames={220}>
          <OutroPortrait />
        </TransitionSeries.Sequence>
      </TransitionSeries>

      <ScanLine opacity={0.04} />
    </AbsoluteFill>
  );
};
