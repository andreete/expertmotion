// Development-only debug dump of agent model calls (process.md Entry 25b): with EM_DEV=1 and EM_DEBUG_AGENT_DUMP=<folder outside
// the repository>, every chat request (system prompt length, messages) and the raw reply (text, finish reason, reasoning tokens)
// is written as one JSON file per call, so a failed live run can be diagnosed from what the model really answered.
// Release builds (`build.mjs --encrypt-prompts`) define `process.env.EM_DEBUG_AGENT_DUMP` as undefined, so the code is dead there.
// No key is ever in a request body here (keys travel only in the adapter's headers); key-like strings are still redacted.
import fs from 'node:fs';
import path from 'node:path';
import type { ChatRequest, ChatResult } from '@expertmotion/agents';

const redact = (s: string) => s.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[REDACTED]').replace(/AIza[A-Za-z0-9_-]{8,}/g, 'AIza[REDACTED]');

/** The dump folder when dumping is on (dev only, absolute, outside the working directory); otherwise null. */
export function agentDumpDir(): string | null {
  const dir = process.env.EM_DEBUG_AGENT_DUMP;
  if (!dir || process.env.EM_DEV !== '1') return null;
  const abs = path.resolve(dir);
  const cwd = path.resolve(process.cwd());
  if (abs === cwd || abs.startsWith(cwd + path.sep)) return null;            // never inside the repository / app folder
  return abs;
}

let seq = 0;
/** Writes one call (request + reply or error). Never throws. */
export function dumpAgentCall(meta: { agent: string; provider: string; model: string }, req: ChatRequest, out: { result?: ChatResult; error?: unknown; ms: number }): void {
  const dir = agentDumpDir();
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const e = out.error as { code?: unknown; message?: unknown; details?: unknown } | undefined;
    const rec = { at: new Date().toISOString(), ...meta, ms: out.ms, maxTokens: req.maxTokens, temperature: req.temperature, systemChars: req.system.length, system: req.system,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      ...(out.result ? { reply: out.result.text, finishReason: out.result.finishReason ?? null, reasoningTokens: out.result.reasoningTokens ?? null, usage: out.result.usage } : {}),
      ...(e ? { error: { code: e.code ?? null, message: String(e.message ?? e), details: e.details ?? null } } : {}) };
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${String(++seq).padStart(3, '0')}-${meta.agent}.json`;
    fs.writeFileSync(path.join(dir, name), redact(JSON.stringify(rec, null, 1)), { mode: 0o600 });
  } catch { /* debug aid only */ }
}
