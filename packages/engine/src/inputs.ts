import { createEmptyModel, type CompositionModelT } from '@expertmotion/composition-model';
/** Media URLs built by the Local Service with a media grant (API_SPECIFICATION §2.2): http://127.0.0.1:<port>/media/<grant>/<assetId>/<variant>. */
export interface AssetUrls { kind: 'video' | 'image' | 'audio'; playable: string; proxy?: string; durationMs?: number; width?: number; height?: number; hasAudio?: boolean }
export interface EngineInputProps { model: CompositionModelT; assets: Record<string, AssetUrls>; quality: 'draft' | 'full';
  /** QA 2026-10-31: the Player's safe mode after a preview error — visual effects are not painted (CSS stand-in); never set for renders. */
  safePreview?: boolean }
export const EMPTY_INPUT: EngineInputProps = { model: createEmptyModel('empty', { autoRatio: false }), assets: {}, quality: 'full' };
