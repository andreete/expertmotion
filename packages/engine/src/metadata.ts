// React-free calculateMetadata shared by the Player (apps/ui) and the renderer (Root.tsx) — ADR-001 "one code path".
import { deriveFrameTiming } from '@expertmotion/composition-model';
import { resolveDimensions } from './formats.js';
import type { EngineInputProps } from './inputs.js';

export interface EngineMetadata { width: number; height: number; fps: number; durationInFrames: number; props: EngineInputProps }
export function calculateMetadata({ props }: { props: EngineInputProps }): EngineMetadata {
  const s = props.model.settings;
  // Draft preview uses the 720p row (PERFORMANCE.md §3); exports always use the project resolution (no Trial Mode cap).
  const resolution = props.quality === 'draft' ? '720p' : s.resolution;
  const { width, height } = resolveDimensions(s.ratio, resolution, s.customRatio);
  const f = deriveFrameTiming(props.model);
  return { width, height, fps: f.fps, durationInFrames: f.durationInFrames, props };
}
