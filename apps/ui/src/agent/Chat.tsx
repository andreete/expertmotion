// Shared pieces of the assistant chat (agent.chat.*, Operator decision 2026-10-26: ONE chat with two modes, "Diskusi" =
// Brainstorming Agent, "Edit" = Editor Agent): CMP-13 bubbles tagged with their agent, the thread, the composer with the
// mode switch, and the header with "Model: <label> ▾" (per mode), status and compact usage.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { CircleHelp, Clapperboard, Copy, ImagePlus, Lightbulb, Maximize2, Minimize2, Paperclip, Scissors, SendHorizontal, ShieldCheck, TriangleAlert, X } from 'lucide-react';
import { errCode, useStore } from '../state/store.js';
import type { AgentKind, CapabilityRow, MessageDto } from '../api/types.js';
import { Button, IconButton, Popover, cx } from '../components/ui.js';
import { qualityOf } from '../components/ModelPicker.js';
import { formatMoney, formatTokens } from '../i18n/index.js';
import { useModelNames } from '../state/use-model-names.js';
import { copyText } from '../api/client.js';
import { ModelText, modelReplyText } from './ModelText.js';
import { ModelPopover } from './ModelPopover.js';

/** FR-072: largest image the composer attaches from disk (EM-1002 above it). */
export const MAX_ATTACH_BYTES = 10 * 1024 * 1024;
/** FR-077: a persisted system line "EM-4101: …" → its code (so a restored failure keeps its inline recovery). */
export const systemCode = (text: string): string | null => /^(EM-\d{4})\b/.exec(text.trim())?.[1] ?? null;
const RETRYABLE = new Set(['EM-4101', 'EM-4102', 'EM-4103', 'EM-4003', 'EM-4301', 'EM-4303', 'EM-4304']);

/** FR-099: the assistant chat either shares the panel with Output Settings or fills it (maximized). */
export interface ChatLayoutProps { maximized: boolean; onToggleMax: () => void }
/** Opens the header model popover for an agent (switching the chat to that agent's mode). */
export const openModelPicker = (agent: AgentKind) => { window.dispatchEvent(new CustomEvent('em:model-picker', { detail: { agent } })); };

const MODE_ICON: Record<AgentKind, typeof Lightbulb> = { brainstorm: Lightbulb, editor: Scissors };
/** The agent tag on a message: "💡 Diskusi" / "✂️ Edit" (icon + mode label; the agent's full name in the tooltip). */
export function ModeTag({ agent, user }: { agent: AgentKind; user?: boolean }) {
  const { t } = useStore();
  const Icon = MODE_ICON[agent];
  return (
    <span data-el="agent.chat.message.agent" data-agent={agent} title={t(`ui.agent.${agent}.title`)}
      className={cx('inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide', agent === 'brainstorm' ? 'text-em-warn' : 'text-em-accent', user && 'opacity-70')}>
      <Icon size={11} aria-hidden />{t(`ui.agent.mode.${agent}`)}
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const { t, actions } = useStore();
  if (!text) return null;
  return (
    <button type="button" data-el="agent.chat.message.copy" aria-label={t('ui.agent.message.copy')} title={t('ui.agent.message.copy')}
      className="text-em-muted opacity-60 hover:text-em-text hover:opacity-100 focus:opacity-100"
      onClick={() => { void copyText(text).then((ok) => { if (ok) actions.announce(t('ui.agent.message.copied')); }); }}><Copy size={12} /></button>
  );
}

export function useAgentAvailability(agent: AgentKind): { reason: string | null; code: string | null } {
  const { state, t } = useStore();
  if (state.settings?.privateMode) return { reason: t('ui.agent.composer.private'), code: 'EM-4401' };
  if (!state.connections.length) return { reason: t('ui.agent.composer.noprovider'), code: 'EM-4001' };
  if (!state.assignments?.[agent]) return { reason: t('err.EM-4007.title'), code: 'EM-4007' };
  return { reason: null, code: null };
}

/** Text of a message as shown (assistant text is model output: any JSON wrapper is unwrapped per block, QA #16). */
export const messageText = (m: MessageDto): string => m.blocks.filter((b) => b.type === 'text').map((b) => (b.type === 'text' ? (m.role === 'assistant' ? modelReplyText(b.text) : b.text) : '')).filter((x) => m.role !== 'assistant' || x).join('\n');

export function Bubble({ m, agent, children, onRetry, onApply, text: override, hideText }: {
  m: MessageDto; agent: AgentKind; children?: ReactNode; onRetry?: (() => void) | undefined;
  /** "Apply to video" (Kerjakan di video) on a Diskusi answer. */ onApply?: (() => void) | undefined;
  /** Shown instead of the stored text (an Editor question); `hideText` = the Plan Card carries the reply. */ text?: string | undefined; hideText?: boolean | undefined;
}) {
  const { t, lang } = useStore();
  const text = override ?? messageText(m);
  const attachments = m.blocks.filter((b) => b.type === 'attachment');
  const time = new Date(m.createdAt);
  const stamp = Number.isNaN(time.getTime()) ? '' : time.toLocaleTimeString(lang === 'id' ? 'id-ID' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
  if (m.role === 'system') {
    const code = systemCode(text);
    if (!code) return <div data-el="agent.chat.message" data-agent={agent} data-role="system" className="mx-auto max-w-[90%] text-center text-[12px] text-em-muted">{text}</div>;
    // FR-077: a saved failure keeps its EM code and an inline recovery after a restart.
    return (
      <div data-el="agent.chat.message" data-agent={agent} data-role="system" data-code={code} className="rounded-[6px] border-l-2 border-em-danger/70 bg-em-panel-2 px-2.5 py-1.5 text-[12px]">
        <div className="flex items-center gap-2"><ModeTag agent={agent} /><span className="flex-1 font-semibold">{t(`err.${code}.title`)}</span><span className="t-mono text-em-muted">{code}</span><span className="text-[10px] text-em-muted">{stamp}</span></div>
        <div className="mt-1 flex gap-2">
          {onRetry && RETRYABLE.has(code) && <Button el="agent.chat.message.retry" size={28} onClick={onRetry}>{t('ui.sys.toast.tryagain')}</Button>}
          {code.startsWith('EM-4') && <Button size={28} variant="ghost" onClick={() => openModelPicker(agent)}>{t('ui.agent.common.switchmodel')}</Button>}
        </div>
      </div>
    );
  }
  const user = m.role === 'user';
  const shown = hideText ? '' : text;
  return (
    <div data-el="agent.chat.message" data-agent={agent} data-role={m.role} className={cx('group flex flex-col gap-1', user ? 'items-end' : 'items-start')}>
      <ModeTag agent={agent} user={user} />
      {shown && (user
        ? <div className="max-w-[92%] whitespace-pre-wrap rounded-[8px] border-l-2 border-em-accent bg-em-panel-2 px-2.5 py-1.5">{shown}</div>
        : <div className="max-w-[92%] rounded-[8px] bg-em-panel-2 px-2.5 py-1.5"><ModelText text={shown} raw /></div>)}
      {attachments.map((a, i) => a.type === 'attachment' && <span key={i} className="rounded-[4px] border border-em-line px-1 text-[11px] text-em-muted">📎 {a.name}</span>)}
      {children}
      {(shown || onApply) && (
        <span className="flex items-center gap-1.5 text-[10px] text-em-muted">{stamp}{shown && <CopyButton text={shown} />}
          {onApply && <button type="button" data-el="agent.chat.apply" title={t('ui.agent.chat.apply.tip')} onClick={onApply}
            className="ml-1 inline-flex items-center gap-1 rounded-[4px] border border-em-accent/60 px-1.5 py-0.5 text-[11px] font-medium text-em-accent hover:bg-em-accent/10"><Clapperboard size={11} aria-hidden />{t('ui.agent.chat.apply')}</button>}
        </span>
      )}
    </div>
  );
}

export function Thread({ label, children, empty }: { label: string; children: ReactNode; empty?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const { state } = useStore();
  const n = state.messages.brainstorm.length + state.messages.editor.length;
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }); }, [n, state.streaming.brainstorm?.text, state.streaming.editor?.text, state.plan?.status]);
  return (
    <div ref={ref} data-el="agent.chat.thread" role="log" aria-live="polite" aria-relevant="additions" aria-label={label} className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 py-2">
      {empty}
      {children}
    </div>
  );
}

export function StreamingBubble({ agent }: { agent: AgentKind }) {
  const { state, actions, t, runtime } = useStore();
  const names = useModelNames();
  const s = state.streaming[agent];
  if (!s) return null;
  const shown = s.text ? modelReplyText(s.text) : '';                          // QA #16: a streamed JSON wrapper is never shown either
  return (
    <div data-el="agent.chat.streaming" data-agent={agent} className="flex flex-col items-start gap-1">
      <ModeTag agent={agent} />
      <div className="text-[12px] text-em-muted">{t('ui.agent.common.asking', { model: names.llm(s.modelId, agent) || t('ui.agent.common.model') })}
        <button type="button" className="ml-2 underline" onClick={() => { void runtime.api.cancelAgentRun(s.runId).catch(() => undefined); if (agent === 'editor') void actions.cancelPlan(); else actions.stopStreaming(agent); }}>{t('ui.common.cancel')}</button>
      </div>
      {shown && <div aria-hidden className="max-w-[92%] rounded-[8px] bg-em-panel-2 px-2.5 py-1.5"><ModelText text={shown} raw /><span className="em-skeleton ml-0.5 inline-block h-3 w-1.5 align-middle" /></div>}
    </div>
  );
}

/** The assigned provider / model names for error copy ({provider}, {model}); absent ones fall back in translate (err.*). */
export function useAgentErrorVars(agent: AgentKind): Record<string, string> {
  const { state, t } = useStore();
  const names = useModelNames();
  const a = state.assignments?.[agent];
  const conn = a ? state.connections.find((c) => c.id === a.connectionId) : undefined;
  const model = a ? names.llm(a.modelId, agent) : '';
  return { ...(conn?.label ? { provider: conn.label, connection: conn.label } : {}), ...(model ? { model } : {}), agent: t(`ui.agent.${agent}.title`) };
}

export function AgentErrorBubble({ agent, onRetry }: { agent: AgentKind; onRetry: () => void }) {
  const { state, actions, t } = useStore();
  const vars = useAgentErrorVars(agent);
  const code = state.agentError[agent];
  if (!code) return null;
  return (
    <div data-el="agent.chat.message" data-agent={agent} data-role="system" role="alert" className="rounded-[6px] border-l-2 border-em-danger bg-em-panel-2 px-2.5 py-1.5">
      <div className="flex items-center gap-2"><ModeTag agent={agent} /><span className="flex-1 font-semibold">{t(`err.${code}.title`, vars)}</span><span className="t-mono text-em-muted">{code}</span></div>
      <div className="text-em-text-2">{t(`err.${code}.body`, vars)}</div>
      <div className="mt-1.5 flex gap-2">
        <Button el="agent.chat.message.retry" size={28} onClick={onRetry}>{t('ui.sys.toast.tryagain')}</Button>
        {code === 'EM-4201'   /* FR-117 / AI-016: Change budget opens Providers on the budget field */
          ? <Button el="agent.chat.budget" size={28} variant="ghost" onClick={() => actions.setScreen({ kind: 'providers', focus: { field: 'project' } })}>{t('err.EM-4201.action')}</Button>
          : <Button size={28} variant="ghost" onClick={() => openModelPicker(agent)}>{t('ui.agent.common.switchmodel')}</Button>}
      </div>
    </div>
  );
}

/** The mode switch in the composer (Ctrl+1 / Ctrl+2, or Tab in an empty composer). */
export function ModeSwitch({ mode, setMode }: { mode: AgentKind; setMode: (m: AgentKind) => void }) {
  const { t } = useStore();
  return (
    <div data-el="agent.chat.mode" role="radiogroup" aria-label={t('ui.agent.chat.mode')} className="flex shrink-0 rounded-[6px] border border-em-line p-0.5">
      {(['brainstorm', 'editor'] as const).map((m, i) => {
        const Icon = MODE_ICON[m];
        const on = m === mode;
        return (
          <button key={m} type="button" role="radio" aria-checked={on} data-el={`agent.chat.mode.${m}`} title={t(`ui.agent.chat.mode.${m}.tip`, { key: `Ctrl+${i + 1}` })} onClick={() => setMode(m)}
            className={cx('flex h-6 items-center gap-1 rounded-[4px] px-1.5 text-[12px]', on ? (m === 'brainstorm' ? 'bg-em-warn/15 font-semibold text-em-warn' : 'bg-em-accent/15 font-semibold text-em-accent') : 'text-em-muted hover:text-em-text')}>
            <Icon size={12} aria-hidden />{t(`ui.agent.mode.${m}`)}
          </button>
        );
      })}
    </div>
  );
}

export function Composer({ mode, setMode, placeholder, chip, onClearChip, value, setValue, onSend }: {
  mode: AgentKind; setMode: (m: AgentKind) => void; placeholder: string; chip?: string | null; onClearChip?: () => void; value: string; setValue: (v: string) => void; onSend: (attachments: string[]) => void;
}) {
  const { state, t, runtime, dispatch } = useStore();
  const agent = mode;
  const { reason } = useAgentAvailability(agent);
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [attachError, setAttachError] = useState<{ code: string; vars?: Record<string, string | number> } | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const cap = useAssignedCapability(agent);
  const imageBlocked = attachments.length > 0 && cap !== null && cap.imageInput === false;     // FR-072: EM-4307 before anything is sent
  const attachFile = async (f: File | undefined) => {
    if (!f) return;
    setAttachOpen(false);
    if (!f.type.startsWith('image/')) { setAttachError({ code: 'EM-1002', vars: { size: f.name, limit: 'PNG/JPEG/WebP' } }); return; }
    if (f.size > MAX_ATTACH_BYTES) { setAttachError({ code: 'EM-1002', vars: { size: `${(f.size / 1048576).toFixed(1)} MB`, limit: '10 MB' } }); return; }
    const projectId = state.project?.id; if (!projectId) return;
    try {
      const res = await runtime.api.uploadAssets(projectId, [f]);
      dispatch({ type: 'assetsUpsert', assets: res.items });
      const id = res.items[0]?.id;
      if (id) { setAttachError(null); setAttachments((x) => [...new Set([...x, id])].slice(0, 4)); }
    } catch (e) { setAttachError({ code: errCode(e) }); }
  };
  const reasonId = 'composer-chat-reason';
  const busy = Boolean(state.streaming[agent]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(6 * 20 + 12, el.scrollHeight)}px`;
  }, [value]);
  useEffect(() => {
    const focus = (e: Event) => {
      const a = (e as CustomEvent<{ agent?: AgentKind }>).detail?.agent;
      if (a) setMode(a);
      ref.current?.focus();
      setTimeout(() => { if (ref.current && document.activeElement !== ref.current) ref.current.focus(); }, 0);
    };
    window.addEventListener('em:focus-composer', focus);
    return () => window.removeEventListener('em:focus-composer', focus);
  }, [setMode]);
  const send = () => { const v = value.trim(); if (!v || reason || busy || imageBlocked) return; onSend(attachments); setAttachments([]); setAttachError(null); };
  const images = state.assets.filter((a) => a.kind === 'image' && a.status === 'ready');
  return (
    <div className="shrink-0 border-t border-em-line p-2">
      {chip && mode === 'editor' && <span className="mb-1 inline-flex items-center gap-1 rounded-full border border-em-accent/60 px-2 text-[11px] text-em-accent">{chip}{onClearChip && <button type="button" aria-label={t('ui.common.remove')} onClick={onClearChip}><X size={12} /></button>}</span>}
      {attachments.length > 0 && <div className="mb-1 flex flex-wrap gap-1">{attachments.map((id) => (
        <span key={id} className="inline-flex items-center gap-1 rounded-[4px] border border-em-line px-1 text-[11px]">📎 {state.assets.find((a) => a.id === id)?.name}
          <button type="button" aria-label={t('ui.agent.composer.attach.remove')} onClick={() => setAttachments((x) => x.filter((y) => y !== id))}><X size={10} /></button></span>))}</div>}
      {(imageBlocked || attachError) && (
        <div data-el="agent.chat.attach.error" role="alert" className="mb-1 rounded-[6px] border-l-2 border-em-warn bg-em-panel-2 px-2 py-1 text-[12px]">
          <div className="flex items-center gap-1.5"><TriangleAlert size={12} className="text-em-warn" /><span className="flex-1">{imageBlocked ? t('err.EM-4307.title') : t(`err.${attachError!.code}.title`)}</span><span className="t-mono text-em-muted">{imageBlocked ? 'EM-4307' : attachError!.code}</span></div>
          <div className="text-em-text-2">{imageBlocked ? t('err.EM-4307.body', { model: cap?.label ?? cap?.modelId ?? '' }) : t(`err.${attachError!.code}.body`, attachError!.vars ?? {})}</div>
          <div className="mt-1 flex gap-2">
            <Button size={28} onClick={() => { setAttachments([]); setAttachError(null); }}>{t('ui.agent.composer.attach.remove')}</Button>
            {imageBlocked && <Button size={28} variant="ghost" onClick={() => openModelPicker(agent)}>{t('ui.agent.common.switchmodel')}</Button>}
          </div>
        </div>
      )}
      <div className={cx('flex flex-col gap-1 rounded-[8px] border border-em-line bg-em-panel-2 p-1', reason && 'opacity-80')}>
        <textarea ref={ref} data-el="agent.chat.composer" data-mode={mode} rows={1} value={value} placeholder={reason ?? placeholder} aria-label={t(`a11y.agent.${agent}.composer`)} aria-describedby={reason ? reasonId : undefined}
          readOnly={Boolean(reason)} onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); send(); }   /* Enter or Ctrl+Enter sends (FR-153) */
            else if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !value) { e.preventDefault(); setMode(mode === 'brainstorm' ? 'editor' : 'brainstorm'); }
          }}
          className="min-h-7 w-full resize-none bg-transparent px-1.5 py-1 text-[14px] leading-5 outline-none placeholder:text-em-muted" />
        <div className="flex items-center gap-1">
          <ModeSwitch mode={mode} setMode={setMode} />
          <span className="relative">
            <IconButton el="agent.chat.attach" data-popover-trigger="" label={t('ui.agent.composer.attach')} icon={<Paperclip size={16} />} size={28} disabledReason={reason} onClick={() => setAttachOpen((o) => !o)} />
            {attachOpen && (
              <Popover onClose={() => setAttachOpen(false)} width={220} label={t('ui.agent.composer.attach')}>
                <button type="button" data-el="agent.chat.attach.file" className="flex w-full items-center gap-1.5 rounded-[6px] px-2 py-1 text-left hover:bg-em-panel" onClick={() => file.current?.click()}><ImagePlus size={14} />{t('ui.agent.composer.attach.file')}</button>
                <div className="my-1 border-t border-em-line" />
                {images.length === 0 ? <div className="p-2 text-em-muted">{t('ui.agent.composer.attach.none')}</div>
                  : images.map((a) => <button key={a.id} type="button" className="block w-full truncate rounded-[6px] px-2 py-1 text-left hover:bg-em-panel" onClick={() => { setAttachments((x) => [...new Set([...x, a.id])].slice(0, 4)); setAttachOpen(false); }}>{a.name}</button>)}
              </Popover>
            )}
            <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden aria-hidden tabIndex={-1} onChange={(e) => { void attachFile(e.target.files?.[0]); e.target.value = ''; }} />
          </span>
          <span className="flex-1" />
          <IconButton el="agent.chat.send" label={t('ui.agent.composer.send')} icon={<SendHorizontal size={16} />} size={28} disabledReason={reason ?? (busy ? t('ui.agent.composer.busy') : imageBlocked ? t('err.EM-4307.title') : null)} onClick={send} />
        </div>
      </div>
      {reason && <span id={reasonId} className="sr-only">{reason}</span>}
    </div>
  );
}

/** The Capability Table row of an agent's Model Assignment (null when unknown). */
export function useAssignedCapability(agent: AgentKind): CapabilityRow | null {
  const { state } = useStore();
  const a = state.assignments?.[agent];
  return (a ? state.capabilities[a.connectionId] ?? [] : []).find((r) => r.modelId === a?.modelId) ?? null;
}

/** FR-074 colour thresholds: amber from 60 %, red from 80 %. */
export const ctxTone = (pct: number): 'danger' | 'warn' | 'muted' => (pct >= 0.8 ? 'danger' : pct >= 0.6 ? 'warn' : 'muted');

/** Connection status of an agent's model for the header dot (FR-071): private / none / error / valid / unvalidated. */
function useStatus(agent: AgentKind): { status: 'private' | 'none' | 'error' | 'valid' | 'unvalidated'; code: string | null } {
  const { state } = useStore();
  const a = state.assignments?.[agent];
  const conn = state.connections.find((c) => c.id === (a?.connectionId ?? state.assignments?.defaultConnectionId)) ?? state.connections[0];
  if (state.settings?.privateMode) return { status: 'private', code: null };
  if (!conn) return { status: 'none', code: null };
  const run = state.agentError[agent];
  const code = run && /^EM-4[0-2]\d\d$/.test(run) ? run : conn.status === 'invalid' ? 'EM-4002' : null;
  return { status: code ? 'error' : conn.status === 'valid' ? 'valid' : 'unvalidated', code };
}

/** Chat header: status dot, "Model: <label> ▾" for the current mode (popover), compact usage, help, maximize. */
export function ChatHeader({ mode, setMode, layout }: { mode: AgentKind; setMode: (m: AgentKind) => void; layout: ChatLayoutProps }) {
  const { state, t, lang, actions } = useStore();
  const names = useModelNames();
  const [picker, setPicker] = useState(false);
  const closePicker = useCallback(() => setPicker(false), []);                        // stable: Popover re-focuses on a new onClose
  const agent = mode;
  const a = state.assignments?.[agent];
  const cap = useAssignedCapability(agent);
  const { status, code } = useStatus(agent);
  useEffect(() => {
    const open = (e: Event) => { const x = (e as CustomEvent<{ agent?: AgentKind }>).detail?.agent; if (x) setMode(x); setPicker(true); };
    window.addEventListener('em:model-picker', open);
    return () => window.removeEventListener('em:model-picker', open);
  }, [setMode]);
  const ctx = state.contextUsage[agent];
  const limit = ctx?.contextLength ?? cap?.contextLength ?? null;
  const used = ctx?.usedTokens ?? 0;
  const pct = limit ? used / limit : 0;
  const last = state.lastUsage[agent];
  const cost = last ? (last.costUsd === null ? `${t('ui.agent.common.cost.na')} (EM-4203)` : formatMoney(last.costUsd, last.approximate, lang)) : '—';
  const tone = ctxTone(pct);
  const statusText = t(`ui.agent.modelbar.status.${status}`);
  const label = a ? names.agent(agent) : '';
  const warn = cap ? qualityOf(cap, agent).level !== 'ok' : false;
  const noConn = !state.connections.length;
  const usageTip = [t('ui.agent.footer.ctx.tooltip'), `${formatTokens(used, lang)} / ${limit ? formatTokens(limit, lang) : 'n/a'}`, t('ui.agent.footer.ctx.cost', { cost }), t('ui.agent.footer.ctx.summary')].join('\n');
  const help = t(`ui.agent.${agent}.help`);
  return (
    <div data-el="agent.chat.header" data-mode={mode} className="flex h-11 shrink-0 items-center gap-1.5 border-b border-em-line px-3">
      <span data-el="agent.chat.status" data-status={status} role="img" aria-label={statusText} title={status === 'error' && code ? `${statusText} · ${code} · ${t(`err.${code}.title`)}` : statusText} className="flex items-center">
        {status === 'private' ? <ShieldCheck size={14} className="text-em-private" /> : <span className={cx('h-2 w-2 rounded-full', status === 'valid' ? 'bg-em-success' : status === 'error' ? 'bg-em-danger' : status === 'none' ? 'border border-em-muted bg-transparent' : 'bg-em-muted')} />}
      </span>
      <span className="relative min-w-0 flex-1">
        {noConn
          ? <button type="button" data-el="agent.chat.model" data-agent={agent} className="truncate font-medium text-em-accent" onClick={() => actions.setScreen({ kind: 'providers' })}>{t('ui.agent.modelbar.connect')}</button>
          : <button type="button" data-el="agent.chat.model" data-agent={agent} data-popover-trigger="" aria-haspopup="dialog" aria-expanded={picker} title={a ? `${t(`ui.agent.${agent}.title`)} · ${a.modelId}` : t(`ui.agent.${agent}.title`)}
              aria-label={t('a11y.agent.chat.model', { agent: t(`ui.agent.${agent}.title`), model: label || t('ui.agent.footer.nomodel'), status: statusText })}
              className="flex max-w-full items-center gap-1 truncate text-left text-[13px] hover:text-em-text" onClick={() => setPicker((p) => !p)}>
              <span className="truncate">{t('ui.agent.chat.model.label', { model: label || t('ui.agent.footer.nomodel') })}</span>
              {warn && <TriangleAlert size={12} className="shrink-0 text-em-warn" aria-hidden />}<span aria-hidden className="text-em-muted">▾</span>
            </button>}
        {picker && <ModelPopover agent={agent} onClose={closePicker} />}
      </span>
      {agent === 'editor' && cap && !cap.toolCalling && <span className="shrink-0 rounded-[4px] border border-em-line px-1 text-[10px] text-em-muted" title={t('ui.agent.footer.jsonmode')}>JSON</span>}
      {a && <span data-el="agent.chat.usage" data-tone={tone} role="status" title={usageTip} aria-label={`${t('a11y.agent.footer.ctx', { used: formatTokens(used, lang), limit: limit ? formatTokens(limit, lang) : 'n/a' })}. ${t('ui.agent.footer.ctx.cost', { cost })}`}
        className={cx('t-mono shrink-0 text-[11px]', tone === 'danger' ? 'text-em-danger' : tone === 'warn' ? 'text-em-warn' : 'text-em-muted')}>
        {formatTokens(used, lang)}{limit ? ` / ${formatTokens(limit, lang)}` : ''}
      </span>}
      <span title={help} aria-label={help} className="shrink-0 text-em-muted"><CircleHelp size={14} /></span>
      <IconButton el="agent.chat.maximize" size={28} aria-pressed={layout.maximized} label={layout.maximized ? t('ui.agent.chat.restore') : t('ui.agent.chat.maximize.one')}
        icon={layout.maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />} onClick={layout.onToggleMax} />
    </div>
  );
}
