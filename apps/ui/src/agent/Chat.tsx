// Shared chat pieces (CMP-13 bubbles, composer, footer) for the Brainstorming Chat and the Editor Chat.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Paperclip, SendHorizontal, X } from 'lucide-react';
import { useStore } from '../state/store.js';
import type { AgentKind, MessageDto } from '../api/types.js';
import { Button, IconButton, Popover, cx } from '../components/ui.js';
import { formatTokens } from '../i18n/index.js';

export function useAgentAvailability(agent: AgentKind): { reason: string | null; code: string | null } {
  const { state, t } = useStore();
  if (state.settings?.privateMode) return { reason: t('ui.agent.composer.private'), code: 'EM-4401' };
  if (!state.connections.length) return { reason: t('ui.agent.composer.noprovider'), code: 'EM-4001' };
  if (!state.assignments?.[agent]) return { reason: t('err.EM-4007.title'), code: 'EM-4007' };
  return { reason: null, code: null };
}

export function Bubble({ m, agent, children }: { m: MessageDto; agent: AgentKind; children?: ReactNode }) {
  const text = m.blocks.filter((b) => b.type === 'text').map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  const attachments = m.blocks.filter((b) => b.type === 'attachment');
  if (m.role === 'system') return <div data-el={`agent.${agent}.message`} data-role="system" className="mx-auto max-w-[90%] text-center text-[12px] text-em-muted">{text}</div>;
  const user = m.role === 'user';
  return (
    <div data-el={`agent.${agent}.message`} data-role={m.role} className={cx('flex flex-col gap-1', user ? 'items-end' : 'items-start')}>
      {text && <div className={cx('max-w-[92%] whitespace-pre-wrap rounded-[8px] px-2.5 py-1.5', user ? 'border-l-2 border-em-accent bg-em-panel-2' : 'bg-em-panel-2')}>{text}</div>}
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
  const s = state.streaming[agent];
  if (!s) return null;
  return (
    <div className="flex flex-col items-start gap-1">
      <div className="text-[12px] text-em-muted">{t('ui.agent.common.asking', { model: s.modelId || t('ui.agent.common.model') })}
        <button type="button" className="ml-2 underline" onClick={() => { void runtime.api.cancelAgentRun(s.runId).catch(() => undefined); if (agent === 'editor') void actions.cancelPlan(); else actions.stopStreaming(agent); }}>{t('ui.common.cancel')}</button>
      </div>
      {s.text && <div aria-hidden className="max-w-[92%] whitespace-pre-wrap rounded-[8px] bg-em-panel-2 px-2.5 py-1.5">{s.text}<span className="em-skeleton ml-0.5 inline-block h-3 w-1.5 align-middle" /></div>}
    </div>
  );
}

export function AgentErrorBubble({ agent, onRetry }: { agent: AgentKind; onRetry: () => void }) {
  const { state, actions, t } = useStore();
  const code = state.agentError[agent];
  if (!code) return null;
  return (
    <div data-el={`agent.${agent}.message`} data-role="system" role="alert" className="rounded-[6px] border-l-2 border-em-danger bg-em-panel-2 px-2.5 py-1.5">
      <div className="flex items-center gap-2"><span className="flex-1 font-semibold">{t(`err.${code}.title`)}</span><span className="t-mono text-em-muted">{code}</span></div>
      <div className="text-em-text-2">{t(`err.${code}.body`)}</div>
      <div className="mt-1.5 flex gap-2">
        <Button size={28} onClick={onRetry}>{t('ui.sys.toast.tryagain')}</Button>
        <Button size={28} variant="ghost" onClick={() => actions.setScreen({ kind: 'providers' })}>{t('ui.agent.common.switchmodel')}</Button>
      </div>
    </div>
  );
}

export function Composer({ agent, placeholder, chip, onClearChip, value, setValue, onSend, extra }: {
  agent: AgentKind; placeholder: string; chip?: string | null; onClearChip?: () => void; value: string; setValue: (v: string) => void; onSend: (attachments: string[]) => void; extra?: ReactNode;
}) {
  const { state, t } = useStore();
  const { reason } = useAgentAvailability(agent);
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachments, setAttachments] = useState<string[]>([]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const reasonId = `composer-${agent}-reason`;
  const busy = Boolean(state.streaming[agent]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(6 * 20 + 12, el.scrollHeight)}px`;
  }, [value]);
  useEffect(() => {
    const focus = (e: Event) => { if ((e as CustomEvent<{ agent: AgentKind }>).detail?.agent === agent) ref.current?.focus(); };
    window.addEventListener('em:focus-composer', focus);
    return () => window.removeEventListener('em:focus-composer', focus);
  }, [agent]);
  const send = () => { const v = value.trim(); if (!v || reason || busy) return; onSend(attachments); setAttachments([]); };
  const images = state.assets.filter((a) => a.kind === 'image' && a.status === 'ready');
  return (
    <div className="border-t border-em-line p-2">
      {chip && <span className="mb-1 inline-flex items-center gap-1 rounded-full border border-em-accent/60 px-2 text-[11px] text-em-accent">{chip}{onClearChip && <button type="button" aria-label={t('ui.common.remove')} onClick={onClearChip}><X size={12} /></button>}</span>}
      {attachments.length > 0 && <div className="mb-1 flex flex-wrap gap-1">{attachments.map((id) => <span key={id} className="rounded-[4px] border border-em-line px-1 text-[11px]">📎 {state.assets.find((a) => a.id === id)?.name}</span>)}</div>}
      <div className={cx('flex items-end gap-1 rounded-[6px] border border-em-line bg-em-panel-2 p-1', reason && 'opacity-60')}>
        <span className="relative">
          <IconButton el={`agent.${agent}.attach`} data-popover-trigger="" label={t('ui.agent.composer.attach')} icon={<Paperclip size={16} />} size={28} disabledReason={reason} onClick={() => setAttachOpen((o) => !o)} />
          {attachOpen && (
            <Popover onClose={() => setAttachOpen(false)} width={220} label={t('ui.agent.composer.attach')}>
              {images.length === 0 ? <div className="p-2 text-em-muted">{t('ui.agent.composer.attach.none')}</div>
                : images.map((a) => <button key={a.id} type="button" className="block w-full truncate rounded-[6px] px-2 py-1 text-left hover:bg-em-panel" onClick={() => { setAttachments((x) => [...new Set([...x, a.id])].slice(0, 4)); setAttachOpen(false); }}>{a.name}</button>)}
            </Popover>
          )}
        </span>
        <textarea ref={ref} data-el={`agent.${agent}.composer`} rows={1} value={value} placeholder={reason ?? placeholder} aria-label={t(`a11y.agent.${agent}.composer`)} aria-describedby={reason ? reasonId : undefined}
          readOnly={Boolean(reason)} onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) { e.preventDefault(); send(); } }}
          className="min-h-7 flex-1 resize-none bg-transparent px-1 py-1 text-[14px] leading-5 outline-none placeholder:text-em-muted" />
        <IconButton el={`agent.${agent}.send`} label={t('ui.agent.composer.send')} icon={<SendHorizontal size={16} />} size={28} disabledReason={reason ?? (busy ? t('ui.agent.composer.busy') : null)} onClick={send} />
        {extra}
      </div>
      {reason && <span id={reasonId} className="sr-only">{reason}</span>}
      <Footer agent={agent} />
    </div>
  );
}

export function Footer({ agent }: { agent: AgentKind }) {
  const { state, actions, t, lang } = useStore();
  const a = state.assignments?.[agent];
  const ctx = state.contextUsage[agent];
  const rows = a ? state.capabilities[a.connectionId] ?? [] : [];
  const cap = rows.find((r) => r.modelId === a?.modelId);
  const limit = ctx?.contextLength ?? cap?.contextLength ?? null;
  const used = ctx?.usedTokens ?? 0;
  const pct = limit ? used / limit : 0;
  return (
    <div className="mt-1 flex items-center gap-2 text-[11px]">
      <button type="button" data-el={`agent.${agent}.footer.model`} className="truncate text-em-muted hover:text-em-text" onClick={() => actions.setScreen({ kind: 'providers' })}>
        {a ? `${a.modelId} ▾` : t('ui.agent.footer.nomodel')}
      </button>
      {agent === 'editor' && cap && !cap.toolCalling && <span className="rounded-[4px] border border-em-line px-1 text-em-muted">{t('ui.agent.footer.jsonmode')}</span>}
      <span className="flex-1" />
      <span data-el={`agent.${agent}.footer.ctx`} role="status" title={t('ui.agent.footer.ctx.tooltip')} aria-label={t('a11y.agent.footer.ctx', { used: formatTokens(used, lang), limit: limit ? formatTokens(limit, lang) : 'n/a' })}
        className={cx('t-mono', pct >= 0.85 ? 'text-em-danger' : pct >= 0.6 ? 'text-em-warn' : 'text-em-muted')}>
        {formatTokens(used, lang)} / {limit ? formatTokens(limit, lang) : 'n/a'}
      </span>
    </div>
  );
}
