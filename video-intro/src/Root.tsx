import React from "react";
import { Composition } from "remotion";
import { SuperAgentIntro } from "./SuperAgentIntro";
import { SuperLoongPortrait } from "./SuperLoongPortrait";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* 60s 横屏完整版（1920×1080）— 官网/B站 */}
      <Composition
        id="SuperAgentIntro"
        component={SuperAgentIntro}
        durationInFrames={1800}
        fps={30}
        width={1920}
        height={1080}
      />
      {/* 60s 竖屏完整版（1080×1920）— 视频号/抖音/B站/官网首页 */}
      <Composition
        id="SuperLoongPortrait"
        component={SuperLoongPortrait}
        durationInFrames={1800}
        fps={30}
        width={1080}
        height={1920}
      />
    </>
  );
};
