// Caption Sub-agent, deterministic part (AGENT_DESIGN §1, ADR-030): caption pages from a script when no transcription model is
// used (faceless videos, a TTS voice-over whose words we already know). Words are timed in proportion to their length over the
// window; pages hold at most `maxWords` words or `maxChars` characters and break after sentence punctuation.
import type { CaptionPageT } from '@expertmotion/composition-model';

export function scriptPages(script: string, fromMs: number, toMs: number, o: { maxWords?: number; maxChars?: number } = {}): CaptionPageT[] {
  const words = script.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const span = Math.max(0, Math.round(toMs - fromMs));
  if (!words.length || span < 100) return [];
  const maxWords = o.maxWords ?? 5, maxChars = o.maxChars ?? 32;
  const groups: string[][] = [];
  let cur: string[] = [];
  for (const w of words) {
    if (cur.length && (cur.length >= maxWords || [...cur, w].join(' ').length > maxChars)) { groups.push(cur); cur = []; }
    cur.push(w);
    if (/[.!?…]$/.test(w)) { groups.push(cur); cur = []; }
  }
  if (cur.length) groups.push(cur);
  const weight = (w: string) => w.length + 1;
  const total = words.reduce((s, w) => s + weight(w), 0);
  let used = 0;
  const at = () => fromMs + Math.round((used / total) * span);
  return groups.map((g) => {
    const startMs = at();
    const tokens = g.map((w) => { const f = at(); used += weight(w); return { text: ` ${w}`, fromMs: f, toMs: at() }; });
    const end = at();
    return { text: tokens.map((t) => t.text).join(''), startMs, durationMs: Math.max(1, end - startMs), tokens };
  });
}
