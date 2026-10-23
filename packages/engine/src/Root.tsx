import React from 'react';
import { Composition } from 'remotion';
import { ExpertmotionTimeline } from './timeline/ExpertmotionTimeline.js';
import { calculateMetadata } from './metadata.js';
import { EMPTY_INPUT, type EngineInputProps } from './inputs.js';

export const RemotionRoot: React.FC = () => (
  <Composition id="ExpertmotionTimeline" component={ExpertmotionTimeline as unknown as React.FC<Record<string, unknown>>} width={1080} height={1920} fps={30} durationInFrames={30}
    defaultProps={EMPTY_INPUT as unknown as Record<string, unknown>}
    calculateMetadata={({ props }) => { const m = calculateMetadata({ props: props as unknown as EngineInputProps }); return { ...m, props: m.props as unknown as Record<string, unknown> }; }} />
);
