// Shared chat pieces (CMP-13 bubbles, composer, footer) for the Brainstorming Chat and the Editor Chat.
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { CircleHelp, Copy, ImagePlus, Maximize2, Minimize2, Paperclip, SendHorizontal, TriangleAlert, X } from 'lucide-react';
import { errCode, useStore } from '../state/store.js';
import type { AgentKind, CapabilityRow, MessageDto } from '../api/types.js';
import { Button, IconButton, Popover, cx, inputCls } from '../components/ui.js';
import { ModelPicker, qualityOf } from '../components/ModelPicker.js';
import { formatMoney, formatTokens } from '../i18n/index.js';
import { useModelNames } from '../state/use-model-names.js';
import { copyText } from '../api/client.js';
import { ModelText, modelReplyText } from './ModelText.js';

/** FR-072: largest image the composer attaches from disk (EM-1002 above it). */
export const MAX_ATTACH_BYTES = 10 * 1024 * 1024;
/** FR-077: a persisted system line "EM-4101: …" → its code (so a restored failure keeps its inline recovery). */
export const systemCode = (text: string): string | null => /^(EM-\d{4})\b/.exec(text.trim())?.[1] ?? null;
const RETRYABLE = new Set(['EM-4101', 'EM-4102', 'EM-4103', 'EM-4003', 'EM-4301', 'EM-4303', 'EM-4304']);

/** FR-099: how a chat sits in the Agent Panel: sharing the height, filling it (maximized), or reduced to its header bar. */
export type ChatView = 'split' | 'max' | 'min';
export interface ChatLayoutProps { view: ChatView; style?: CSSProperties; onToggleMax: () => void; onRestore: () => void }
const CHAT_MIN_CLS = { brainstorm: 'min-h-[140px]', editor: 'min-h-[200px]' } as const;   // LAYOUT.chat.min / .editorMin
/** Section classes per view: minimum height only in the split view; a reduced chat is just its header bar. */
export const chatSectionCls = (agent: AgentKind, view: ChatView) => cx('flex flex-col overflow-hidden', view === 'split' ? CHAT_MIN_CLS[agent] : view === 'max' ? 'min-h-0' : 'shrink-0');

/** Chat header (FR-099): title, help, maximize/restore toggle. Reduced (`min`), the title is a button that restores the split. */
export function ChatHeader({ agent, title, help, layout }: { agent: AgentKind; title: string; help: string; layout: ChatLayoutProps }) {
  const { t } = useStore();
  const min = layout.view === 'min', max = layout.view === 'max';
  return (
    <div data-el={`agent.${agent}.header`} data-view={layout.view} className={cx('flex shrink-0 items-center gap-1 px-3', min ? 'py-1' : 'pt-1.5')}>
      {min
        ? <button type="button" className="t-label flex-1 text-left hover:text-em-text" aria-label={t('ui.agent.chat.show', { name: title })} title={t('ui.agent.chat.show', { name: title })} onClick={layout.onRestore}>{title}</button>
        : <span className="t-label flex-1">{title}</span>}
      <span title={help} aria-label={help} className="text-em-muted"><CircleHelp size={14} /></span>
      <IconButton el={`agent.${agent}.maximize`} size={28} aria-pressed={max}
        label={max || min ? t('ui.agent.chat.restore') : t('ui.agent.chat.maximize', { name: title })}
        icon={max || min ? <Minimize2 size={14} /> : <Maximize2 size={14} />} onClick={max || min ? layout.onRestore : layout.onToggleMax} />
    </div>
  );
}

function CopyButton({ agent, text }: { agent: AgentKind; text: string }) {
  const { t, actions } = useStore();
  if (!text) return null;
  return (
    <button type="button" data-el={`agent.${agent}.message.copy`} aria-label={t('ui.agent.message.copy')} title={t('ui.agent.message.copy')}
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

export function Bubble({ m, agent, children, onRetry }: { m: MessageDto; agent: AgentKind; children?: ReactNode; onRetry?: (() => void) | undefined }) {
  const { t, lang, actions } = useStore();
  // QA #16: assistant text is model output: unwrap any JSON wrapper per block (also for messages stored before the fix).
  const text = m.blocks.filter((b) => b.type === 'text').map((b) => (b.type === 'text' ? (m.role === 'assistant' ? modelReplyText(b.text) : b.text) : '')).filter((x) => m.role !== 'assistant' || x).join('\n');
  const attachments = m.blocks.filter((b) => b.type === 'attachment');
  const time = new Date(m.createdAt);
  const stamp = Number.isNaN(time.getTime()) ? '' : time.toLocaleTimeString(lang === 'id' ? 'id-ID' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
  if (m.role === 'system') {
    const code = systemCode(text);
    if (!code) return <div data-el={`agent.${agent}.message`} data-role="system" className="mx-auto max-w-[90%] text-center text-[12px] text-em-muted">{text}</div>;
    // FR-077: a saved failure keeps its EM code and an inline recovery after a restart.
    return (
      <div data-el={`agent.${agent}.message`} data-role="system" data-code={code} className="rounded-[6px] border-l-2 border-em-danger/70 bg-em-panel-2 px-2.5 py-1.5 text-[12px]">
        <div className="flex items-center gap-2"><span className="flex-1 font-semibold">{t(`err.${code}.title`)}</span><span className="t-mono text-em-muted">{code}</span><span className="text-[10px] text-em-muted">{stamp}</span></div>
        <div className="mt-1 flex gap-2">
          {onRetry && RETRYABLE.has(code) && <Button el={`agent.${agent}.message.retry`} size={28} onClick={onRetry}>{t('ui.sys.toast.tryagain')}</Button>}
          {code.startsWith('EM-4') && <Button size={28} variant="ghost" onClick={() => actions.setScreen({ kind: 'providers' })}>{t('ui.agent.common.switchmodel')}</Button>}
        </div>
      </div>
    );
  }
  const user = m.role === 'user';
  return (
    <div data-el={`agent.${agent}.message`} data-role={m.role} className={cx('group flex flex-col gap-1', user ? 'items-end' : 'items-start')}>
      {text && (user
        ? <div className="max-w-[92%] whitespace-pre-wrap rounded-[8px] border-l-2 border-em-accent bg-em-panel-2 px-2.5 py-1.5">{text}</div>
        : <div className="max-w-[92%] rounded-[8px] bg-em-panel-2 px-2.5 py-1.5"><ModelText text={text} raw /></div>)}
      {text && <span className="flex items-center gap-1.5 text-[10px] text-em-muted">{stamp}<CopyButton agent={agent} text={text} /></span>}
      {attachments.map((a, i) => a.type === 'attachment' && <span key={i} className="rounded-[4px] border border-em-line px-1 text-[11px] text-em-muted">📎 {a.name}</span>)}
      {children}
    </div>
  );
}

export function Thread({ agent, label, children, empty }: { agent: AgentKind; label: string; children: ReactNode; empty?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const { state } = useStore();
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }); }, [state.messages[agent].length, state.streaming[agent]?.text]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={ref} data-el={`agent.${agent}.thread`} role="log" aria-live="polite" aria-relevant="additions" aria-label={label} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-2">
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
    <div className="flex flex-col items-start gap-1">
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
    <div data-el={`agent.${agent}.message`} data-role="system" role="alert" className="rounded-[6px] border-l-2 border-em-danger bg-em-panel-2 px-2.5 py-1.5">
      <div className="flex items-center gap-2"><span className="flex-1 font-semibold">{t(`err.${code}.title`, vars)}</span><span className="t-mono text-em-muted">{code}</span></div>
      <div className="text-em-text-2">{t(`err.${code}.body`, vars)}</div>
      <div className="mt-1.5 flex gap-2">
        <Button size={28} onClick={onRetry}>{t('ui.sys.toast.tryagain')}</Button>
        {code === 'EM-4201'   /* FR-117 / AI-016: Change budget opens Providers on the budget field */
          ? <Button el={`agent.${agent}.budget`} size={28} variant="ghost" onClick={() => actions.setScreen({ kind: 'providers', focus: { field: 'project' } })}>{t('err.EM-4201.action')}</Button>
          : <Button size={28} variant="ghost" onClick={() => actions.setScreen({ kind: 'providers' })}>{t('ui.agent.common.switchmodel')}</Button>}
      </div>
    </div>
  );
}

export function Composer({ agent, placeholder, chip, onClearChip, value, setValue, onSend, extra }: {
  agent: AgentKind; placeholder: string; chip?: string | null; onClearChip?: () => void; value: string; setValue: (v: string) => void; onSend: (attachments: string[]) => void; extra?: ReactNode;
}) {
  const { state, t, runtime, dispatch } = useStore();
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
  const reasonId = `composer-${agent}-reason`;
  const busy = Boolean(state.streaming[agent]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(6 * 20 + 12, el.scrollHeight)}px`;
  }, [value]);
  useEffect(() => {
    const focus = (e: Event) => {
      if ((e as CustomEvent<{ agent: AgentKind }>).detail?.agent !== agent) return;
      ref.current?.focus();
      setTimeout(() => { if (ref.current && document.activeElement !== ref.current) ref.current.focus(); }, 0);   // FR-099: after a reduced chat is restored
    };
    window.addEventListener('em:focus-composer', focus);
    return () => window.removeEventListener('em:focus-composer', focus);
  }, [agent]);
  const send = () => { const v = value.trim(); if (!v || reason || busy || imageBlocked) return; onSend(attachments); setAttachments([]); setAttachError(null); };
  const images = state.assets.filter((a) => a.kind === 'image' && a.status === 'ready');
  return (
    <div className="shrink-0 border-t border-em-line p-2">
      {chip && <span className="mb-1 inline-flex items-center gap-1 rounded-full border border-em-accent/60 px-2 text-[11px] text-em-accent">{chip}{onClearChip && <button type="button" aria-label={t('ui.common.remove')} onClick={onClearChip}><X size={12} /></button>}</span>}
      {attachments.length > 0 && <div className="mb-1 flex flex-wrap gap-1">{attachments.map((id) => (
        <span key={id} className="inline-flex items-center gap-1 rounded-[4px] border border-em-line px-1 text-[11px]">📎 {state.assets.find((a) => a.id === id)?.name}
          <button type="button" aria-label={t('ui.agent.composer.attach.remove')} onClick={() => setAttachments((x) => x.filter((y) => y !== id))}><X size={10} /></button></span>))}</div>}
      {(imageBlocked || attachError) && (
        <div data-el={`agent.${agent}.attach.error`} role="alert" className="mb-1 rounded-[6px] border-l-2 border-em-warn bg-em-panel-2 px-2 py-1 text-[12px]">
          <div className="flex items-center gap-1.5"><TriangleAlert size={12} className="text-em-warn" /><span className="flex-1">{imageBlocked ? t('err.EM-4307.title') : t(`err.${attachError!.code}.title`)}</span><span className="t-mono text-em-muted">{imageBlocked ? 'EM-4307' : attachError!.code}</span></div>
          <div className="text-em-text-2">{imageBlocked ? t('err.EM-4307.body', { model: cap?.label ?? cap?.modelId ?? '' }) : t(`err.${attachError!.code}.body`, attachError!.vars ?? {})}</div>
          <div className="mt-1 flex gap-2">
            <Button size={28} onClick={() => { setAttachments([]); setAttachError(null); }}>{t('ui.agent.composer.attach.remove')}</Button>
            {imageBlocked && <Button size={28} variant="ghost" onClick={() => window.dispatchEvent(new CustomEvent('em:model-picker', { detail: { agent } }))}>{t('ui.agent.common.switchmodel')}</Button>}
          </div>
        </div>
      )}
      <div className={cx('flex items-end gap-1 rounded-[6px] border border-em-line bg-em-panel-2 p-1', reason && 'opacity-60')}>
        <span className="relative">
          <IconButton el={`agent.${agent}.attach`} data-popover-trigger="" label={t('ui.agent.composer.attach')} icon={<Paperclip size={16} />} size={28} disabledReason={reason} onClick={() => setAttachOpen((o) => !o)} />
          {attachOpen && (
            <Popover onClose={() => setAttachOpen(false)} width={220} label={t('ui.agent.composer.attach')}>
              <button type="button" data-el={`agent.${agent}.attach.file`} className="flex w-full items-center gap-1.5 rounded-[6px] px-2 py-1 text-left hover:bg-em-panel" onClick={() => file.current?.click()}><ImagePlus size={14} />{t('ui.agent.composer.attach.file')}</button>
              <div className="my-1 border-t border-em-line" />
              {images.length === 0 ? <div className="p-2 text-em-muted">{t('ui.agent.composer.attach.none')}</div>
                : images.map((a) => <button key={a.id} type="button" className="block w-full truncate rounded-[6px] px-2 py-1 text-left hover:bg-em-panel" onClick={() => { setAttachments((x) => [...new Set([...x, a.id])].slice(0, 4)); setAttachOpen(false); }}>{a.name}</button>)}
            </Popover>
          )}
          <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden aria-hidden tabIndex={-1} onChange={(e) => { void attachFile(e.target.files?.[0]); e.target.value = ''; }} />
        </span>
        <textarea ref={ref} data-el={`agent.${agent}.composer`} rows={1} value={value} placeholder={reason ?? placeholder} aria-label={t(`a11y.agent.${agent}.composer`)} aria-describedby={reason ? reasonId : undefined}
          readOnly={Boolean(reason)} onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); send(); } }}   /* Enter or Ctrl+Enter sends (FR-153) */
          className="min-h-7 flex-1 resize-none bg-transparent px-1 py-1 text-[14px] leading-5 outline-none placeholder:text-em-muted" />
        <IconButton el={`agent.${agent}.send`} label={t('ui.agent.composer.send')} icon={<SendHorizontal size={16} />} size={28} disabledReason={reason ?? (busy ? t('ui.agent.composer.busy') : imageBlocked ? t('err.EM-4307.title') : null)} onClick={send} />
        {extra}
      </div>
      {reason && <span id={reasonId} className="sr-only">{reason}</span>}
      <Footer agent={agent} />
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

/** FR-073: per-agent model popover with the shared ModelPicker (compact) over one validated connection (a connection select
 *  appears when there are several); a pick switches that agent's model for the next request only and closes the popover,
 *  unless the model carries a quality warning (Operator decision 2026-10-25), which then stays visible in the popover. */
function FooterModelPicker({ agent, onClose }: { agent: AgentKind; onClose: () => void }) {
  const { state, runtime, dispatch, actions, t } = useStore();
  const names = useModelNames();
  const valid = state.connections.filter((c) => c.status === 'valid');
  const cur = state.assignments?.[agent];
  const [connId, setConnId] = useState<string | null>(cur && valid.some((c) => c.id === cur.connectionId) ? cur.connectionId : valid[0]?.id ?? null);
  const [loading, setLoading] = useState(false);
  const rows = connId ? state.capabilities[connId] ?? [] : [];
  useEffect(() => {                                                                      // cached Capability Table (R-095, no provider call)
    if (!connId || state.capabilities[connId]) return;
    setLoading(true);
    runtime.api.connectionModels(connId).then((r) => dispatch({ type: 'capabilities', connectionId: connId, rows: r.items })).catch(() => undefined).finally(() => setLoading(false));
  }, [connId]); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = async () => {
    if (!connId) return;
    setLoading(true);
    try { const r = await runtime.api.refreshConnectionModels(connId); dispatch({ type: 'capabilities', connectionId: connId, rows: r.items }); } catch (e) { actions.error(e); }
    setLoading(false);
  };
  const pick = async (modelId: string) => {
    if (!connId) return;
    try {
      const a = await runtime.api.putAssignments({ [agent]: { agent, connectionId: connId, modelId, settings: cur?.connectionId === connId ? cur.settings : {} } });
      dispatch({ type: 'providers', assignments: a });
      actions.announce(t('ui.agent.footer.model.changed', { model: names.llm(modelId, agent, connId) }));
      const row = rows.find((r) => r.modelId === modelId);                              // a warned pick keeps the popover open so the
      if (!row || qualityOf(row, agent).level === 'ok') onClose();                       // warning and "Use recommended instead" show
    } catch (e) { actions.error(e); }
  };
  return (
    <Popover el={`agent.${agent}.footer.model.popover`} onClose={onClose} width={400} label={t('ui.agent.footer.model.title')}>
      {valid.length === 0 || !connId ? <div className="p-2 text-em-muted">{t('ui.agent.composer.noprovider')}</div> : (
        <div className="flex flex-col gap-1.5 p-1">
          {valid.length > 1 && (
            <select data-el={`agent.${agent}.footer.model.connection`} aria-label={t('ui.agent.footer.model.connection')} className={cx(inputCls, '!h-7')} value={connId} onChange={(e) => setConnId(e.target.value)}>
              {valid.map((c) => <option key={c.id} value={c.id}>{c.label || t(`ui.scr.providers.provider.${c.provider}`)}</option>)}
            </select>
          )}
          <ModelPicker compact el={`agent.${agent}.footer.model.picker`} rows={rows} agent={agent} value={cur?.connectionId === connId ? cur.modelId : ''} loading={loading}
            onSelect={(id) => void pick(id)} onRefresh={() => void refresh()} refreshDisabledReason={state.settings?.privateMode ? t('err.EM-8202.title') : null} />
        </div>
      )}
      <button type="button" className="mt-1 w-full px-2 py-1 text-left text-[11px] text-em-accent underline" onClick={() => { onClose(); actions.setScreen({ kind: 'providers' }); }}>{t('ui.agent.footer.model.manage')}</button>
    </Popover>
  );
}

export function Footer({ agent }: { agent: AgentKind }) {
  const { state, t, lang } = useStore();
  const names = useModelNames();
  const [picker, setPicker] = useState(false);
  const closePicker = useCallback(() => setPicker(false), []);                        // stable: Popover re-focuses on a new onClose
  const a = state.assignments?.[agent];
  const ctx = state.contextUsage[agent];
  const cap = useAssignedCapability(agent);
  useEffect(() => {
    const open = (e: Event) => { if ((e as CustomEvent<{ agent: AgentKind }>).detail?.agent === agent) setPicker(true); };
    window.addEventListener('em:model-picker', open);
    return () => window.removeEventListener('em:model-picker', open);
  }, [agent]);
  const limit = ctx?.contextLength ?? cap?.contextLength ?? null;
  const used = ctx?.usedTokens ?? 0;
  const pct = limit ? used / limit : 0;
  const last = state.lastUsage[agent];
  const cost = last ? (last.costUsd === null ? `${t('ui.agent.common.cost.na')} (EM-4203)` : formatMoney(last.costUsd, last.approximate, lang)) : '—';
  const tooltip = [t('ui.agent.footer.ctx.tooltip'), t('ui.agent.footer.ctx.summary'), t('ui.agent.footer.ctx.cost', { cost })].join('\n');
  const tone = ctxTone(pct);
  return (
    <div className="mt-1 flex items-center gap-2 text-[11px]">
      <span className="relative min-w-0">
        <button type="button" data-el={`agent.${agent}.footer.model`} data-popover-trigger="" aria-haspopup="dialog" aria-expanded={picker} className="max-w-full truncate text-em-muted hover:text-em-text" onClick={() => setPicker((p) => !p)}>
          {a ? <span title={a.modelId}>{`${names.agent(agent)} ▾`}</span> : t('ui.agent.footer.nomodel')}
        </button>
        {picker && <FooterModelPicker agent={agent} onClose={closePicker} />}
      </span>
      {agent === 'editor' && cap && !cap.toolCalling && <span className="rounded-[4px] border border-em-line px-1 text-em-muted">{t('ui.agent.footer.jsonmode')}</span>}
      <span className="flex-1" />
      <span data-el={`agent.${agent}.footer.ctx`} data-tone={tone} role="status" title={tooltip} aria-label={`${t('a11y.agent.footer.ctx', { used: formatTokens(used, lang), limit: limit ? formatTokens(limit, lang) : 'n/a' })}. ${t('ui.agent.footer.ctx.summary')} ${t('ui.agent.footer.ctx.cost', { cost })}`}
        className={cx('t-mono', tone === 'danger' ? 'text-em-danger' : tone === 'warn' ? 'text-em-warn' : 'text-em-muted')}>
        {formatTokens(used, lang)} / {limit ? formatTokens(limit, lang) : 'n/a'}
      </span>
    </div>
  );
}
