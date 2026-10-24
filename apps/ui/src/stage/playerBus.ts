// Live playhead channel between the Player and the Timeline View. Frame updates are too frequent for the app reducer,
// so they go through this tiny pub/sub; the store keeps the settled playhead (on pause/seek) only.
export interface PlayerController {
  toggle(): void;
  play(): void;
  pause(): void;
  seekMs(ms: number): void;
  stepFrames(n: number): void;
  currentMs(): number;
  durationMs(): number;
  fullscreen(): void;
  isPlaying(): boolean;
}
let controller: PlayerController | null = null;
const listeners = new Set<(ms: number) => void>();
export const playerBus = {
  set(c: PlayerController | null) { controller = c; },
  get(): PlayerController | null { return controller; },
  subscribe(fn: (ms: number) => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; },
  emit(ms: number) { for (const l of listeners) l(ms); },
};
