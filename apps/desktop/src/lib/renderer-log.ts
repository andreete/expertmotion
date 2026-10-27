/**
 * Editor → Shell log bridge (FR-185, SEC-031, SEC-100). The Editor's error boundary and its window `error` /
 * `unhandledrejection` handlers send `{level, code?, message, stack?, source}` through the preload's `logError`; main
 * validates the sender and the argument, rate-limits, caps the size, strips query strings and e-mail addresses, and writes
 * the line through the Shell log (which redacts secrets and user-profile paths). Pure module: no `electron` import.
 */
import { z } from 'zod';

export const RENDERER_LOG_SOURCES = ['error-boundary', 'window-error', 'unhandled-rejection'] as const;
export const RendererLogArg = z.object({
  level: z.enum(['warn', 'error']),
  code: z.string().regex(/^EM-\d{4}$/).optional(),
  message: z.string().max(4000),
  stack: z.string().max(20_000).optional(),
  source: z.enum(RENDERER_LOG_SOURCES),
}).strict();
export type RendererLog = z.infer<typeof RendererLogArg>;

export const MAX_MESSAGE_CHARS = 500;
export const MAX_STACK_CHARS = 4000;
export const MAX_STACK_LINES = 30;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const QUERY = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#'")]*)[?#][^\s'")]*/gi;
const clean = (s: string): string => s.replace(QUERY, '$1').replace(EMAIL, '[email]');

/** Fields for the Shell log line, or null when the argument is invalid. */
export function rendererLogFields(raw: unknown): { level: 'warn' | 'error'; msg: string; fields: Record<string, unknown> } | null {
  const p = RendererLogArg.safeParse(raw);
  if (!p.success) return null;
  const e = p.data;
  const stack = e.stack === undefined ? undefined : clean(e.stack).split('\n').slice(0, MAX_STACK_LINES).join('\n').slice(0, MAX_STACK_CHARS);
  return {
    level: e.level,
    msg: 'renderer error',
    fields: { source: e.source, ...(e.code ? { code: e.code } : {}), message: clean(e.message).slice(0, MAX_MESSAGE_CHARS), ...(stack ? { stack } : {}) },
  };
}

/** Fixed-window limiter: at most `max` calls per `windowMs` (a render loop that throws cannot flood the log). */
export function createRateLimiter(max: number, windowMs: number): (now: number) => boolean {
  let start = -Infinity, count = 0;
  return (now) => {
    if (now - start >= windowMs) { start = now; count = 0; }
    if (count >= max) return false;
    count += 1;
    return true;
  };
}

/**
 * FR-198: every renderer console warning / error reaches the Shell log, so a React crash before the error boundary (or a crash
 * of the boundary itself) is diagnosable without the UI. Electron 45 `console-message` gives `level` as a string
 * ('info' | 'warning' | 'error' | 'debug'); older numeric levels (2 = warning, 3 = error) are accepted too. The message and the
 * source URL lose query strings and e-mail addresses, are capped, and then pass the Shell log's redaction.
 */
export function consoleLogEntry(level: unknown, message: unknown, sourceId?: unknown, line?: unknown): { level: 'warn' | 'error'; msg: string; fields: Record<string, unknown> } | null {
  const lv = level === 'error' || level === 3 ? 'error' : level === 'warning' || level === 2 ? 'warn' : null;
  if (lv === null || typeof message !== 'string') return null;
  const fields: Record<string, unknown> = { message: clean(message).slice(0, MAX_MESSAGE_CHARS) };
  if (typeof sourceId === 'string' && sourceId !== '') fields['source'] = clean(sourceId).slice(0, 200);
  if (typeof line === 'number' && Number.isInteger(line) && line > 0) fields['line'] = line;
  return { level: lv, msg: 'renderer console', fields };
}

/** Rate limiter that also counts what it dropped, so the next allowed line says how many were skipped. */
export function createCountingLimiter(max: number, windowMs: number): (now: number) => { ok: boolean; dropped: number } {
  const allow = createRateLimiter(max, windowMs);
  let dropped = 0;
  return (now) => {
    if (!allow(now)) { dropped += 1; return { ok: false, dropped }; }
    const d = dropped; dropped = 0;
    return { ok: true, dropped: d };
  };
}
