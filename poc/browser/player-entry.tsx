import React, { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Player, type PlayerRef } from '@remotion/player';
import { ExpertmotionTimeline, calculateMetadata, type EngineInputProps } from '@expertmotion/engine';

declare global { interface Window { __mount: (p: EngineInputProps, scale: number) => Promise<{ width: number; height: number }>; __seek: (f: number) => Promise<void>; __state: Record<string, unknown> } }
let ref: PlayerRef | null = null;
window.__state = { waiting: 0 };
window.__mount = async (props, scale) => {
  const m = calculateMetadata({ props });
  const App = () => {
    const r = useRef<PlayerRef>(null);
    React.useEffect(() => { ref = r.current; r.current?.addEventListener('waiting', () => { (window.__state['waiting'] as number)++; }); r.current?.addEventListener('resume', () => { (window.__state['waiting'] as number)--; }); }, []);
    return <Player ref={r} component={ExpertmotionTimeline as unknown as React.FC<Record<string, unknown>>} inputProps={props as unknown as Record<string, unknown>} durationInFrames={m.durationInFrames} fps={m.fps}
      compositionWidth={m.width} compositionHeight={m.height} style={{ width: m.width * scale, height: m.height * scale }} acknowledgeRemotionLicense numberOfSharedAudioTags={0} />;
  };
  const el = document.getElementById('root')!;
  createRoot(el).render(<App />);
  for (let i = 0; i < 100 && !ref; i++) await new Promise((r) => setTimeout(r, 50));
  return { width: m.width * scale, height: m.height * scale };
};
window.__seek = async (frame) => {
  ref!.seekTo(frame);
  await new Promise((r) => setTimeout(r, 300));
  for (let i = 0; i < 100 && (window.__state['waiting'] as number) > 0; i++) await new Promise((r) => setTimeout(r, 100));
  await document.fonts.ready;
  await new Promise((r) => setTimeout(r, 1500));          // media decode + rough-notation drawing settle
};
