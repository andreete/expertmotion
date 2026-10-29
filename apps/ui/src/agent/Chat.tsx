// Shared pieces of the assistant chat (agent.chat.*, Operator decision 2026-10-26: ONE chat with two modes, "Diskusi" =
// Brainstorming Agent, "Edit" = Editor Agent): CMP-13 bubbles tagged with their agent, the thread, the composer with the
// mode switch, and the header with "Model: <label> ▾" (per mode), status and compact usage.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AtSign, CircleHelp, Clapperboard, Copy, ExternalLink as ExternalIcon, FileText, Globe, ImagePlus, Info, Lightbulb, Loader, Maximize2, Minimize2, Music, Paperclip, Scissors, SendHorizontal, ShieldCheck, Square, TriangleAlert, X } from 'lucide-react';
import { errCode, useStore } from '../state/store.js';
import type { AgentKind, CapabilityRow, ChatDocumentDto, ChatTarget, ImageCandidateDto, MessageDto, WebSourceDto } from '../api/types.js';
import { useOpenSource } from '../components/ExternalLink.js';
import type { AgentErrorDetail } from '../state/reducer.js';
import { isRecentKey, keyRetryDelay } from '../state/key-retry.js';
import { targetKey } from './targets.js';
import { Button, IconButton, Popover, cx, noEllipsis } from '../components/ui.js';
import { qualityOf } from '../components/ModelPicker.js';
import { formatMoney, formatNumber, formatTokens } from '../i18n/index.js';
import { useModelNames } from '../state/use-model-names.js';
import { copyText } from '../api/client.js';
import { ModelText, modelReplyText } from './ModelText.js';
import { ModelPopover } from './ModelPopover.js';
import { SectionBoundary } from '../startup/ErrorBoundary.js';
import { PhaseStepper } from './Handoff.js';

/** FR-072: largest image the composer attaches from disk (EM-1002 above it). */
export const MAX_ATTACH_BYTES = 10 * 1024 * 1024;
/** FR-077: a persisted system line "EM-4101: …" → its code (so a restored failure keeps its inline recovery). */
export const systemCode = (text: string): string | null => /^(EM-\d{4})\b/.exec(text.trim())?.[1] ?? null;

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

export function Bubble({ m, agent, children, onRetry, onApply, text: override, hideText, collapsible }: {
  m: MessageDto; agent: AgentKind; children?: ReactNode; onRetry?: (() => void) | undefined;
  /** Entry 36: a long message the Creator did not type (the "Send to Editor" draft) starts folded to four lines. */ collapsible?: boolean | undefined;
  /** "Apply to video" (Kerjakan di video) on a Diskusi answer. */ onApply?: (() => void) | undefined;
  /** Shown instead of the stored text (an Editor question); `hideText` = the Plan Card carries the reply. */ text?: string | undefined; hideText?: boolean | undefined;
}) {
  const { t, lang } = useStore();
  const [open, setOpen] = useState(false);
  const text = override ?? messageText(m);
  const attachments = m.blocks.filter((b) => b.type === 'attachment');
  const time = new Date(m.createdAt);
  const stamp = Number.isNaN(time.getTime()) ? '' : time.toLocaleTimeString(lang === 'id' ? 'id-ID' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
  if (m.role === 'system') {
    const code = systemCode(text);
    if (!code) return <div data-el="agent.chat.message" data-agent={agent} data-role="system" className="mx-auto max-w-[90%] text-center text-[12px] text-em-muted">{text}</div>;
    // FR-077: a saved failure keeps its EM code, its reason and an inline recovery after a restart (same card as a live failure).
    const reason = text.trim().replace(/^EM-\d{4}:?\s*/, '');
    return <ErrorCard agent={agent} code={code} detail={reason ? { message: reason } : null} stamp={stamp} onRetry={onRetry} saved />;
  }
  const user = m.role === 'user';
  const shown = hideText ? '' : text;
  const foldable = Boolean(collapsible && user && shown.split('\n').length + shown.length / 60 > 5);
  return (
    <div data-el="agent.chat.message" data-agent={agent} data-role={m.role} className={cx('group flex flex-col gap-1', user ? 'items-end' : 'items-start')}>
      <ModeTag agent={agent} user={user} />
      {shown && (user
        ? <div className="flex max-w-[92%] flex-col items-end gap-0.5">
            <div data-el="agent.chat.message.text" data-folded={foldable && !open ? 'true' : undefined} className="rounded-[8px] border-l-2 border-em-accent bg-em-panel-2 px-2.5 py-1.5">
              {/* the clamp sits inside the padding, or a sliver of line 5 shows in the bottom padding */}
              <div className={cx('whitespace-pre-wrap', foldable && !open && 'line-clamp-4')}>{shown}</div>
            </div>
            {foldable && <button type="button" data-el="agent.chat.message.fold" aria-expanded={open} className="text-[11px] text-em-accent underline" onClick={() => setOpen((v) => !v)}>{t(open ? 'ui.agent.message.fold.less' : 'ui.agent.message.fold.more')}</button>}
          </div>
        : <div className="max-w-[92%] rounded-[8px] bg-em-panel-2 px-2.5 py-1.5"><ModelText text={shown} raw /></div>)}
      {attachments.map((a, i) => a.type === 'attachment' && (
        <span key={i} data-el="agent.chat.message.attachment" data-sent={a.sent} data-kind={a.documentId ? 'document' : a.mime.split('/')[0]} className="flex max-w-[92%] flex-col items-end">
          <span className="rounded-[4px] border border-em-line px-1 text-[11px] text-em-muted">{a.documentId ? '📄' : a.mime.startsWith('audio') ? '🎵' : '📎'} {a.name}{a.sent === 'text' && typeof a.chars === 'number' ? ` · ${t('ui.agent.message.attach.chars', { n: a.chars.toLocaleString(lang === 'id' ? 'id-ID' : 'en-GB') })}` : ''}</span>
          {a.sent === 'name' && <span className="text-[11px] text-em-muted">{t('ui.agent.message.attach.nameonly')}</span>}
          {a.truncated && <span data-el="agent.chat.message.attachment.truncated" className="text-[11px] text-em-warn">{t('ui.agent.message.attach.truncated')}</span>}
        </span>))}
      {m.blocks.map((b, i) => (b.type === 'targets' && b.items.length ? (
        <span key={`t${i}`} data-el="agent.chat.message.targets" className="flex max-w-[92%] flex-wrap justify-end gap-1">
          {b.items.map((x) => <span key={targetKey(x)} data-kind={x.kind} className="inline-flex items-center gap-0.5 rounded-full border border-em-accent/50 px-1.5 text-[11px] text-em-accent"><AtSign size={10} aria-hidden />{x.label}</span>)}
        </span>) : null))}
      {m.role === 'assistant' && <ResearchBlocks m={m} />}
      {children}
      {(shown || onApply) && (
        <span className="flex items-center gap-1.5 text-[10px] text-em-muted">{stamp}{shown && <CopyButton text={shown} />}
          {onApply && <button type="button" data-el="agent.chat.sendtoeditor" title={t('ui.agent.handoff.send.tip')} onClick={onApply}
            className="ml-1 inline-flex items-center gap-1 rounded-[4px] border border-em-accent/60 px-1.5 py-0.5 text-[11px] font-medium text-em-accent hover:bg-em-accent/10"><Clapperboard size={11} aria-hidden />{t('ui.agent.handoff.send')}</button>}
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

/** Seconds since Send, from 2 s on, for the whole run, so a long reasoning model never looks frozen (Entry 25b, FR-214). */
function Elapsed({ since }: { since?: number | undefined }) {
  const { t } = useStore();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!since) return; const h = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(h); }, [since]);
  const s = since ? Math.floor((now - since) / 1000) : 0;
  return s >= 2 ? <span data-elapsed={s} className="t-mono text-em-muted"> · {t('ui.agent.progress.elapsed', { s })}</span> : null;
}

/** FR-214: stops the agent's current run (also before the Service answered the send: then only the local state is cleared). */
export function useStopRun(agent: AgentKind): () => void {
  const { state, actions } = useStore();
  // Review U2: the store cancels the run once its id is known (Stop while still "sending") and never an unrelated plan.
  return useCallback(() => {
    if (!state.streaming[agent]) return;
    void actions.stopRun(agent);
  }, [state.streaming, agent, actions]);
}

/**
 * The running agent in the thread (FR-214, QA 2026-10-27 "dikira error"): from Send to the answer it shows the agent tag, an animated
 * typing indicator, what the agent is doing now ("Mencari di katalog…", "Memikirkan ide…") with the elapsed seconds, Stop, and the
 * answer text as it streams. There is no moment between Send and the answer without it.
 */
export function StreamingBubble({ agent }: { agent: AgentKind }) {
  const { state, t } = useStore();
  const stop = useStopRun(agent);
  const s = state.streaming[agent];
  if (!s) return null;
  const shown = s.text ? modelReplyText(s.text) : '';                          // QA #16: a streamed JSON wrapper is never shown either
  return (
    <div data-el="agent.chat.streaming" data-agent={agent} data-phase={s.phase ?? 'sending'} role="status" aria-live="polite" className="flex flex-col items-start gap-1">
      <ModeTag agent={agent} />
      <div className="flex max-w-[92%] items-center gap-2 rounded-[8px] bg-em-panel-2 px-2.5 py-1.5 text-[12px] text-em-text-2">
        <span data-el="agent.chat.typing" aria-hidden className="em-typing inline-flex items-center gap-0.5"><i /><i /><i /></span>
        <span data-el="agent.chat.progress" data-phase={s.phase ?? 'sending'} className="inline-flex items-center gap-1">{progressText(s, t, agent)}<Elapsed since={s.since} /></span>
        <button type="button" data-el="agent.chat.progress.stop" className="ml-1 underline" onClick={stop}>{t('ui.agent.composer.stop')}</button>
      </div>
      {agent === 'editor' && <div className="w-full max-w-[92%] rounded-[8px] bg-em-panel-2 px-2.5 py-1.5"><PhaseStepper /></div>}
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

/** Read-only tools in the Creator's words while the agent uses them (FR-214). */
const TOOL_PROGRESS: Record<string, string> = {
  'catalogue.search': 'ui.agent.progress.tool.catalogue', 'composition.get': 'ui.agent.progress.reading', 'assets.list': 'ui.agent.progress.tool.assets', 'assets.probe': 'ui.agent.progress.tool.probe',
  'hardware.profile': 'ui.agent.progress.tool.hardware', 'project.settings.get': 'ui.agent.progress.tool.settings', 'render.estimate': 'ui.agent.progress.tool.estimate', 'composition.validateOps': 'ui.agent.progress.tool.validate',
  'web.search': 'ui.agent.progress.tool.web.search', 'web.fetch': 'ui.agent.progress.tool.web.fetch', 'web.images': 'ui.agent.progress.tool.web.images',
  'footage.read': 'ui.agent.progress.tool.footage',                                   // FR-262: transcribing the Creator's footage first
};
const hostOf = (u: string | undefined): string => { try { return u ? new URL(u).hostname.replace(/^www\./, '') : ''; } catch { return ''; } };
/** QA 2026-10-26 #5 / FR-214: what the running agent is doing (agent.run.progress), in the Creator's words, per agent. */
export function progressText(p: { phase?: string | undefined; attempt?: number | undefined; of?: number | undefined; tool?: string | undefined; attaching?: boolean | undefined; query?: string | undefined; url?: string | undefined }, t: (k: string, v?: Record<string, string | number>) => string, agent: AgentKind = 'editor'): string {
  const b = agent === 'brainstorm';
  switch (p.phase) {
    case undefined: case 'sending': return t(p.attaching ? 'ui.agent.progress.attaching' : 'ui.agent.progress.sending');
    case 'reading': return t('ui.agent.progress.reading');
    case 'planning': return t(b ? 'ui.agent.progress.brainstorm.planning' : 'ui.agent.progress.planning');
    case 'thinking': return t(b ? 'ui.agent.progress.brainstorm.thinking' : 'ui.agent.progress.editor.thinking');
    case 'writing': return t(b ? 'ui.agent.progress.brainstorm.writing' : 'ui.agent.progress.editor.writing');
    case 'checking': return t('ui.agent.progress.checking');
    case 'correcting': return p.of ? t('ui.agent.progress.correcting.of', { n: p.attempt ?? 2, of: p.of }) : t('ui.agent.progress.correcting', { n: p.attempt ?? 2 });
    case 'waiting': return t('ui.agent.progress.waiting', { n: p.attempt ?? 1, of: p.of ?? 2 });
    case 'tool':
      // FR-216: "Mencari di internet: <query>…" / "Membaca halaman: <host>…"
      if (p.tool === 'web.search' || p.tool === 'web.images') return p.query ? t(`${TOOL_PROGRESS[p.tool]!}.q`, { query: p.query.length > 70 ? `${p.query.slice(0, 69)}…` : p.query }) : t(TOOL_PROGRESS[p.tool]!);
      if (p.tool === 'web.fetch') return p.url ? t('ui.agent.progress.tool.web.fetch.q', { host: hostOf(p.url) }) : t(TOOL_PROGRESS[p.tool]!);
      return p.tool && TOOL_PROGRESS[p.tool] ? t(TOOL_PROGRESS[p.tool]!) : t('ui.agent.progress.tool', { tool: p.tool ?? '…' });
    default: return t(b ? 'ui.agent.progress.brainstorm.planning' : 'ui.agent.progress.planning');
  }
}
/** FR-216 / FR-217: sources (clickable, opened in the system browser), picture candidates (Import), research notices. */
export function ResearchBlocks({ m }: { m: MessageDto }) {
  const { t } = useStore();
  const sources = m.blocks.flatMap((b) => (b.type === 'sources' ? [b] : []));
  const images = m.blocks.flatMap((b) => (b.type === 'image_candidates' ? b.items : []));
  const notices = m.blocks.flatMap((b) => (b.type === 'notice' ? [b] : []));
  if (!sources.length && !images.length && !notices.length) return null;
  return (
    <>
      {sources.map((b, i) => <SourcesList key={`s${i}`} items={b.items} queries={b.queries ?? []} />)}
      {images.length > 0 && <ImageCandidates m={m} items={images} />}
      {notices.map((n, i) => (
        <div key={`n${i}`} data-el="agent.chat.message.notice" data-code={n.code} role="note" className="flex max-w-[92%] items-start gap-1.5 rounded-[6px] border-l-2 border-em-warn bg-em-panel-2 px-2 py-1 text-[12px] text-em-text-2">
          <Globe size={12} className="mt-0.5 shrink-0 text-em-warn" aria-hidden /><span className="flex-1">{t(`err.${n.code}.body`) !== `err.${n.code}.body` ? t(`err.${n.code}.body`) : n.text}</span><span className="t-mono text-[10px] text-em-muted">{n.code}</span>
        </div>))}
    </>
  );
}
export function SourcesList({ items, queries }: { items: readonly WebSourceDto[]; queries: readonly string[] }) {
  const { t } = useStore();
  const openExternal = useOpenSource();   // R1: Shell openSource route, Private Mode refusal with a copyable address
  return (
    <div data-el="agent.chat.message.sources" className="flex max-w-[92%] flex-col gap-0.5 rounded-[6px] border border-em-line px-2 py-1 text-[11px]">
      <span className="flex items-center gap-1 font-semibold text-em-text-2"><Globe size={11} aria-hidden />{t('ui.agent.research.sources', { n: items.length })}{queries.length ? <span className="font-normal text-em-muted" title={queries.join('\n')}> · {t('ui.agent.research.searched', { n: queries.length })}</span> : null}</span>
      <ol className="flex flex-col gap-0.5">
        {items.map((x, i) => (
          <li key={x.url} className="flex min-w-0 items-baseline gap-1">
            <span className="t-mono text-em-muted">[{i + 1}]</span>
            <a data-el="agent.chat.message.source" href={x.url} title={x.citedText ? `“${x.citedText}”\n${x.url}` : x.url} className="min-w-0 truncate text-em-accent underline" onClick={(e) => { e.preventDefault(); openExternal(x.url); }}>{x.title || hostOf(x.url)}</a>
            <span className="shrink-0 text-em-muted">{hostOf(x.url)}{x.pageAge ? ` · ${x.pageAge}` : ''}</span>
          </li>))}
      </ol>
    </div>
  );
}
export function ImageCandidates({ m, items }: { m: MessageDto; items: readonly ImageCandidateDto[] }) {
  const { t, actions } = useStore();
  const openExternal = useOpenSource();
  const [busy, setBusy] = useState<string | null>(null);
  const licence = (x: ImageCandidateDto) => (x.license === 'cc0' ? 'CC0' : x.license === 'pdm' ? t('ui.agent.research.image.pd') : `CC ${x.license.toUpperCase()}${x.licenseVersion ? ` ${x.licenseVersion}` : ''}`);
  return (
    <div data-el="agent.chat.message.images" className="flex max-w-[92%] flex-col gap-1 rounded-[6px] border border-em-line px-2 py-1 text-[11px]">
      <span className="font-semibold text-em-text-2">{t('ui.agent.research.images', { n: items.length })}</span>
      {items.map((x) => (
        <div key={`${x.source}:${x.id}`} data-el="agent.chat.message.image" data-imported={x.importedAssetId ? 'true' : undefined} className="flex min-w-0 items-center gap-1.5">
          <ImagePlus size={12} className="shrink-0 text-em-muted" aria-hidden />
          <span className="min-w-0 flex-1 truncate" title={`${x.title}${x.creator ? ` — ${x.creator}` : ''}`}>{x.title}{x.creator ? <span className="text-em-muted"> · {x.creator}</span> : null}</span>
          <span className="shrink-0 rounded-[4px] border border-em-line px-1 text-em-muted">{licence(x)}</span>
          {x.landingUrl && <button type="button" aria-label={t('ui.agent.research.image.source')} title={x.landingUrl} className="shrink-0 text-em-muted hover:text-em-text" onClick={() => openExternal(x.landingUrl!)}><ExternalIcon size={11} /></button>}
          {x.importedAssetId ? <span className="shrink-0 text-em-success">{t('ui.agent.research.image.inlibrary')}</span>
            : <Button el="agent.chat.message.image.import" size={28} variant="secondary" loading={busy === x.id} onClick={() => { setBusy(x.id); void actions.importResearchImage(m, x.source, x.id).finally(() => setBusy(null)); }}>{t('ui.agent.research.image.import')}</Button>}
        </div>))}
      <span className="text-[10px] text-em-muted">{t('ui.agent.research.images.note')}</span>
    </div>
  );
}

/** The recovery actions of an agent failure, by EM code (QA 2026-10-26 #5). `retry` is always offered unless a fix comes first. */
export type ErrorAction = 'retry' | 'providers' | 'rephrase' | 'switchmodel' | 'budget';
export function errorActions(code: string): ErrorAction[] {
  if (code === 'EM-4002') return ['retry', 'providers'];
  if (code === 'EM-4001' || code === 'EM-4007') return ['providers'];
  if (code === 'EM-4301' || code === 'EM-4302') return ['rephrase', 'switchmodel'];
  if (code === 'EM-4102') return ['retry', 'switchmodel'];
  if (code === 'EM-4201') return ['budget'];
  if (code === 'EM-4401' || code === 'EM-8202') return [];
  return ['retry'];
}

/**
 * One failure card for live failures (agent.run.failed / a refused send) and saved ones (system message "EM-xxxx: reason"):
 * title, the reason, the code small, and the next action. EM-4002 on a key added in the last 5 minutes adds the "new keys need
 * a minute" hint with an automatic retry every ~20 s (at most 3) and "Coba lagi" (live failures only).
 */
export function ErrorCard({ agent, code, detail, stamp, onRetry, onRephrase, saved }: { agent: AgentKind; code: string; detail: AgentErrorDetail | null; stamp?: string; onRetry?: (() => void) | undefined; onRephrase?: (() => void) | undefined; saved?: boolean }) {
  const { actions, state, t } = useStore();
  const vars = useAgentErrorVars(agent);
  const recent = !saved && code === 'EM-4002' && isRecentKey(detail?.details);
  const [auto, setAuto] = useState(0);
  const [left, setLeft] = useState<number | null>(null);
  const delay = recent && onRetry ? keyRetryDelay(auto, code, true) : null;
  useEffect(() => {
    if (delay === null) { setLeft(null); return; }
    const until = Date.now() + delay;
    setLeft(Math.ceil(delay / 1000));
    const tick = setInterval(() => setLeft(Math.max(0, Math.ceil((until - Date.now()) / 1000))), 1000);
    const fire = setTimeout(() => { setAuto((n) => n + 1); onRetry?.(); }, delay);
    return () => { clearInterval(tick); clearTimeout(fire); };
  }, [delay, code]); // eslint-disable-line react-hooks/exhaustive-deps
  // QA P1 2026-10-29: EM-4002 says "Key tidak valid" + the provider's own reason; the activation hint only for a recent key, only
  // next to that reason, only while automatic retries remain; afterwards (or for an older key) "the key is wrong" + "Ganti key".
  const keyReason = code === 'EM-4002' && typeof detail?.details?.['reason'] === 'string' ? String(detail.details['reason']).trim() : '';
  const keyWrong = code === 'EM-4002' && delay === null;
  const title = code === 'EM-4002' ? t('ui.agent.error.keyinvalid') : t(`err.${code}.title`, vars);
  // EM-4102 after the automatic retries: the Service's text is English provider wording; a free model gets its own copy.
  const free = code === 'EM-4102' && /:free$/.test(state.assignments?.[agent]?.modelId ?? '');
  const daily = code === 'EM-4102' && detail?.details?.['daily'] === true;
  const reason = code === 'EM-4002' ? (keyReason ? t('ui.agent.error.keyreason', { provider: vars['provider'] ?? 'Provider', reason: keyReason }) : t('err.EM-4002.body', vars)) : code === 'EM-4102' ? t(daily ? 'err.EM-4102.daily.body' : free ? 'err.EM-4102.free.body' : 'err.EM-4102.body', vars) : detail?.message && detail.message !== title ? detail.message : t(`err.${code}.body`, vars);
  const list = (keyWrong ? (['providers', 'retry'] as ErrorAction[]) : errorActions(code)).filter((a) => a !== 'retry' || onRetry).filter((a) => a !== 'rephrase' || onRephrase || true);
  const run = (a: ErrorAction) => {
    if (a === 'retry') onRetry?.();
    else if (a === 'providers') actions.setScreen({ kind: 'providers' });
    else if (a === 'budget') actions.setScreen({ kind: 'providers', focus: { field: 'project' } });
    else if (a === 'switchmodel') openModelPicker(agent);
    else if (onRephrase) onRephrase(); else window.dispatchEvent(new CustomEvent('em:focus-composer', { detail: { agent } }));
  };
  const label: Record<ErrorAction, string> = { retry: t('ui.sys.toast.tryagain'), providers: code === 'EM-4002' ? t('ui.agent.error.replacekey') : t('ui.agent.error.providers'), rephrase: t('ui.agent.error.rephrase'), switchmodel: t('ui.agent.common.switchmodel'), budget: t('err.EM-4201.action') };
  return (
    <div data-el="agent.chat.message" data-agent={agent} data-role="system" data-code={code} role={saved ? undefined : 'alert'} className="rounded-[6px] border-l-2 border-em-danger bg-em-panel-2 px-2.5 py-1.5 text-[12px]">
      <div className="flex items-center gap-2"><ModeTag agent={agent} /><span className="flex-1 font-semibold">{title}</span><span className="t-mono text-[10px] text-em-muted">{code}</span>{stamp ? <span className="text-[10px] text-em-muted">{stamp}</span> : null}</div>
      <div data-el="agent.chat.error.reason" className="text-em-text-2">{reason}</div>
      {keyWrong && <div data-el="agent.chat.error.keywrong" className="mt-1 text-em-text-2">{t('ui.agent.error.keywrong')}</div>}
      {recent && delay !== null && (
        <div data-el="agent.chat.error.keyhint" role="status" className="mt-1 text-em-warn">{keyReason ? t('ui.agent.error.keyhint') : ''}{left !== null ? ` ${t('ui.agent.error.keyhint.retry', { s: left })}` : ''}</div>
      )}
      {list.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-2">
          {list.map((a, i) => (
            <Button key={a} el={a === 'retry' ? 'agent.chat.message.retry' : a === 'budget' ? 'agent.chat.budget' : 'agent.chat.error.action'} data-action={a} size={28} variant={i === 0 ? 'secondary' : 'ghost'} onClick={() => run(a)}>{label[a]}</Button>
          ))}
        </div>
      )}
    </div>
  );
}

export function AgentErrorBubble({ agent, onRetry, onRephrase }: { agent: AgentKind; onRetry: () => void; onRephrase?: () => void }) {
  const { state } = useStore();
  const code = state.agentError[agent];
  if (!code) return null;
  return <ErrorCard agent={agent} code={code} detail={state.agentErrorDetail?.[agent] ?? null} onRetry={onRetry} onRephrase={onRephrase} />;
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

/**
 * ADR-033 / FR-219 (QA 2026-10-28 #2, Operator request): Diskusi and Editor are two separate chats again, each with its own thread,
 * shown as two clearly different tabs (colour, icon, name); a dot marks unread answers, a spinner a running agent. They stay
 * connected: shared context, "Kirim ke Editor", hand-off progress in both, "Tanya Diskusi" from the Editor.
 */
export function ChatTabs({ mode, setMode, unread }: { mode: AgentKind; setMode: (m: AgentKind) => void; unread: Record<AgentKind, boolean> }) {
  const { t, state } = useStore();
  return (
    <div data-el="agent.chat.tabs" role="tablist" aria-label={t('ui.agent.chat.mode')} className="flex h-10 shrink-0 items-stretch border-b border-em-line">
      {(['brainstorm', 'editor'] as const).map((m, i) => {
        const Icon = MODE_ICON[m]; const on = m === mode; const busy = Boolean(state.streaming[m]);
        return (
          <button key={m} type="button" role="tab" aria-selected={on} data-el={`agent.chat.tab.${m}`} data-busy={busy ? 'true' : undefined} data-unread={unread[m] && !on ? 'true' : undefined}
            title={t(`ui.agent.chat.mode.${m}.tip`, { key: `Ctrl+${i + 1}` })} onClick={() => setMode(m)}
            className={cx('relative flex flex-1 items-center justify-center gap-1.5 border-b-2 text-[13px]', on ? (m === 'brainstorm' ? 'border-em-warn bg-em-warn/10 font-semibold text-em-warn' : 'border-em-accent bg-em-accent/10 font-semibold text-em-accent') : 'border-transparent text-em-muted hover:text-em-text')}>
            <Icon size={14} aria-hidden />{t(`ui.agent.tab.${m}`)}
            {busy && <Loader size={12} className="em-spin" aria-label={t('ui.agent.tab.busy')} />}
            {unread[m] && !on && <span aria-label={t('ui.agent.tab.unread')} className="h-2 w-2 rounded-full bg-em-danger" />}
          </button>
        );
      })}
    </div>
  );
}

/** FR-216: "Riset internet" on / off in the chat header (setting `webResearch`; Private Mode always blocks it). */
export function ResearchToggle() {
  const { t, state, actions } = useStore();
  const priv = Boolean(state.settings?.privateMode);
  // Entry 36 (UI QA): with no working AI connection there is nobody to research — the chip said "Web on" anyway. It now
  // reads "Web" (muted, aria-disabled) and its tooltip says what to do first; the setting itself is kept for later.
  const noAi = !state.connections.some((c) => c.status === 'valid');
  const blocked = priv || noAi;
  const on = !blocked && state.settings?.webResearch !== false;
  const tip = priv ? t('ui.agent.research.toggle.private') : noAi ? t('ui.agent.research.toggle.noai') : on ? t('ui.agent.research.toggle.on.tip') : t('ui.agent.research.toggle.off.tip');
  return (
    <button type="button" data-el="agent.chat.research" role="switch" aria-checked={on} aria-label={t('ui.agent.research.toggle')} title={tip} aria-disabled={blocked || undefined}
      onClick={() => { if (!blocked) void actions.putSettings({ webResearch: !on }); }}
      className={cx('flex shrink-0 items-center gap-0.5 rounded-[4px] border px-1 text-[10px]', on ? 'border-em-accent-2/60 text-em-accent-2' : 'border-em-line text-em-muted', blocked && 'cursor-not-allowed opacity-60')}>
      <Globe size={11} aria-hidden />{noAi && !priv ? t('ui.agent.research.toggle.idle') : on ? t('ui.agent.research.toggle.on') : t('ui.agent.research.toggle.off')}
    </button>
  );
}

/** QA UX round 1: the Service accepts 8 000 characters per message (SendBody); the counter shows from 6 000. */
export const COMPOSER_MAX = 8000, COMPOSER_COUNTER_FROM = 6000;
/** FR-213: image types the composer attaches (the Service sends PNG / JPEG / WebP / GIF as image parts). */
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
/** FR-221 (QA 2026-10-28 #14): music / voice files become Library assets and chips; documents and scripts are read as text. */
const AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus'];
const DOC_EXTS = ['pdf', 'docx', 'txt', 'md', 'markdown', 'srt', 'vtt', 'csv', 'json', 'rtf', 'fountain', 'fdx'];
const extOf = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();
/** Largest audio file the composer attaches (the Library's own limit applies on import too). */
export const MAX_AUDIO_BYTES = 500 * 1024 * 1024;
export const MAX_DOC_BYTES = 20 * 1024 * 1024;

export function Composer({ mode, setMode, placeholder, targets = [], onRemoveTarget, value, setValue, onSend }: {
  mode: AgentKind; setMode: (m: AgentKind) => void; placeholder: string; value: string; setValue: (v: string) => void; onSend: (attachments: string[], documents: string[]) => void;
  /** QA 2026-10-26 #6: the pointed assets / Timeline elements, sent as `targets` with the next message (removable chips). */
  targets?: ChatTarget[]; onRemoveTarget?: (t: ChatTarget) => void;
}) {
  const { state, t, runtime, dispatch, actions } = useStore();
  const agent = mode;
  const { reason, code: reasonCode } = useAgentAvailability(agent);
  // Entry 35: typing or Send in a composer that cannot send (no provider, Private Mode, no model) says why with its next action
  // (EM-4001 / EM-4007 → Providers, EM-4401 → turn Private Mode off) instead of silently doing nothing. At most once per 4 s.
  const blockedToastAt = useRef({ at: 0, agent });
  const explainBlocked = () => {
    if (!reason || !reasonCode || (blockedToastAt.current.agent === agent && Date.now() - blockedToastAt.current.at < 4000)) return;
    blockedToastAt.current = { at: Date.now(), agent };
    actions.toast('info', `err.${reasonCode}.title`, undefined, { code: reasonCode });
  };
  const stop = useStopRun(agent);
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [attachError, setAttachError] = useState<{ code: string; vars?: Record<string, string | number> } | null>(null);
  const [importing, setImporting] = useState(false);
  const [docs, setDocs] = useState<ChatDocumentDto[]>([]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const cap = useAssignedCapability(agent);
  const attached = attachments.map((id) => state.assets.find((a) => a.id === id)).filter((a): a is NonNullable<typeof a> => Boolean(a));
  // FR-213: a model without image input still gets the message, with the file name instead of the picture (said here before Send).
  const nameOnly = attached.some((a) => a.kind === 'image') && cap?.imageInput === false;
  const preparing = importing || attached.some((a) => a.status === 'ingesting');
  const failed = attached.find((a) => a.status === 'failed');
  useEffect(() => {                                                                 // an attachment whose import failed is removed with its reason
    if (!failed) return;
    setAttachments((x) => x.filter((y) => y !== failed.id));
    setAttachError({ code: failed.errorCode && /^EM-\d{4}$/.test(failed.errorCode) ? failed.errorCode : 'EM-1003', vars: { name: failed.name } });
  }, [failed?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Imports one image into the project (Shell: by path, the packaged way; browser development: raw upload) and attaches it. */
  const importImage = async (run: () => Promise<{ items: Array<{ id: string; status: string; errorCode?: string | null; name: string }>; notices: Array<{ code: string; assetId?: string }> }>) => {
    setImporting(true); setAttachError(null);
    try {
      const res = await run();
      dispatch({ type: 'assetsUpsert', assets: res.items as never });
      const item = res.items[0]; const dup = res.notices.find((n) => n.code === 'EM-1006' && n.assetId);
      const id = item && item.status !== 'failed' ? item.id : dup?.assetId;
      if (item?.status === 'failed') setAttachError({ code: item.errorCode && /^EM-\d{4}$/.test(item.errorCode) ? item.errorCode : 'EM-1003', vars: { name: item.name } });
      else if (id) setAttachments((x) => [...new Set([...x, id])].slice(0, 4));
      else if (res.notices[0]) setAttachError({ code: res.notices[0].code });
    } catch (e) { setAttachError({ code: errCode(e) }); } finally { setImporting(false); }
  };
  const shell = typeof window !== 'undefined' ? window.expertmotion : undefined;
  /** FR-221: a document is read as text by the Service (nothing uploaded anywhere); it shows as a chip with its size in characters. */
  const attachDocument = async (run: () => Promise<{ document: ChatDocumentDto }>) => {
    setImporting(true); setAttachError(null);
    try { const r = await run(); setDocs((d) => [...d.filter((x) => x.id !== r.document.id), r.document].slice(0, 3)); }
    catch (e) { setAttachError({ code: errCode(e) }); } finally { setImporting(false); }
  };
  const pickFile = async (what: 'image' | 'audio' | 'document') => {
    setAttachOpen(false);
    const projectId = state.project?.id; if (!projectId) return;
    if (runtime.mode === 'live' && shell?.pickFiles) {
      const exts = what === 'image' ? IMAGE_EXTS : what === 'audio' ? AUDIO_EXTS : DOC_EXTS;
      const label = t(what === 'image' ? 'ui.agent.composer.attach.images' : what === 'audio' ? 'ui.agent.composer.attach.audio' : 'ui.agent.composer.attach.docs');
      const paths = await shell.pickFiles({ filters: [{ name: label, extensions: exts }], multiple: false }).catch(() => [] as string[]);
      if (!paths[0]) return;
      if (what === 'document') await attachDocument(() => runtime.api.attachDocumentPath(projectId, paths[0]!));
      else await importImage(() => runtime.api.importAssetPaths(projectId, paths.slice(0, 1)));
      return;
    }
    if (file.current) { file.current.accept = what === 'image' ? 'image/png,image/jpeg,image/webp,image/gif' : what === 'audio' ? AUDIO_EXTS.map((e) => `.${e}`).join(',') : DOC_EXTS.map((e) => `.${e}`).join(','); file.current.click(); }
  };
  const pickImage = () => pickFile('image');
  const attachFile = async (f: File | undefined) => {
    if (!f) return;
    setAttachOpen(false);
    const ext = extOf(f.name);
    const projectId = state.project?.id; if (!projectId) return;
    const paths = runtime.mode === 'live' ? shell?.getPathsForFiles?.([f]) ?? [] : [];
    if (DOC_EXTS.includes(ext)) {
      if (f.size > MAX_DOC_BYTES) { setAttachError({ code: 'EM-1002', vars: { size: `${(f.size / 1048576).toFixed(1)} MB`, limit: '20 MB' } }); return; }
      await attachDocument(() => (paths[0] ? runtime.api.attachDocumentPath(projectId, paths[0]) : runtime.api.attachDocumentFile(projectId, f)));
      return;
    }
    if (AUDIO_EXTS.includes(ext) || f.type.startsWith('audio/')) {
      if (f.size > MAX_AUDIO_BYTES) { setAttachError({ code: 'EM-1002', vars: { size: `${(f.size / 1048576).toFixed(0)} MB`, limit: '500 MB' } }); return; }
      await importImage(() => (paths[0] ? runtime.api.importAssetPaths(projectId, paths.slice(0, 1)) : runtime.api.uploadAssets(projectId, [f])));
      return;
    }
    if (!f.type.startsWith('image/')) { setAttachError({ code: 'EM-1001', vars: { name: f.name } }); return; }
    if (f.size > MAX_ATTACH_BYTES) { setAttachError({ code: 'EM-1002', vars: { size: `${(f.size / 1048576).toFixed(1)} MB`, limit: '10 MB' } }); return; }
    await importImage(() => (paths[0] ? runtime.api.importAssetPaths(projectId, paths.slice(0, 1)) : runtime.api.uploadAssets(projectId, [f])));
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
  // QA: Send needs text (not only spaces) and at most the Service's 8 000 characters; a counter shows from 6 000 on.
  const chars = [...value].length, tooLong = chars > COMPOSER_MAX, empty = !value.trim() && !attachments.length && !docs.length;
  const send = () => { const v = value.trim(); if (!v || tooLong || reason || busy || preparing) return; onSend(attachments, docs.map((d) => d.id)); setAttachments([]); setDocs([]); setAttachError(null); };
  const images = state.assets.filter((a) => (a.kind === 'image' || a.kind === 'audio') && a.status === 'ready');
  return (
    <div className="shrink-0 border-t border-em-line p-2">
      {targets.length > 0 && (
        <div data-el="agent.chat.targets" role="list" aria-label={t('ui.agent.chat.targets')} className="mb-1 flex flex-wrap gap-1">
          {targets.map((x) => (
            <span key={targetKey(x)} role="listitem" data-el="agent.chat.target" data-kind={x.kind} title={t('ui.agent.chat.target.tip')} className="inline-flex max-w-full items-center gap-0.5 rounded-full border border-em-accent/60 px-1.5 text-[11px] text-em-accent">
              <AtSign size={10} aria-hidden /><span className="truncate">{x.label}</span>
              {onRemoveTarget && <button type="button" data-el="agent.chat.target.remove" aria-label={t('ui.agent.chat.target.remove', { label: x.label })} onClick={() => onRemoveTarget(x)}><X size={11} /></button>}
            </span>
          ))}
        </div>
      )}
      {(attached.length > 0 || docs.length > 0 || importing) && <div className="mb-1 flex flex-wrap gap-1">{attached.map((a) => (
        <span key={a.id} data-el="agent.chat.attach.chip" data-status={a.status} data-kind={a.kind} className="inline-flex items-center gap-1 rounded-[4px] border border-em-line px-1 text-[11px]">
          {a.status === 'ingesting' ? <Loader size={10} className="em-spin" aria-hidden /> : a.kind === 'audio' ? <Music size={10} aria-hidden /> : <ImagePlus size={10} aria-hidden />}{a.name}
          <button type="button" aria-label={t('ui.agent.composer.attach.remove')} onClick={() => setAttachments((x) => x.filter((y) => y !== a.id))}><X size={10} /></button></span>))}
        {docs.map((d) => (
          <span key={d.id} data-el="agent.chat.attach.chip" data-kind="document" data-truncated={d.truncated ? 'true' : undefined} title={d.truncated ? t('ui.agent.message.attach.truncated') : undefined} className="inline-flex items-center gap-1 rounded-[4px] border border-em-line px-1 text-[11px]">
            <FileText size={10} aria-hidden />{d.name} <span className="text-em-muted">· {t('ui.agent.message.attach.chars', { n: d.chars.toLocaleString() })}{d.truncated ? ' ✂' : ''}</span>
            <button type="button" aria-label={t('ui.agent.composer.attach.remove')} onClick={() => setDocs((x) => x.filter((y) => y.id !== d.id))}><X size={10} /></button></span>))}
        {preparing && <span data-el="agent.chat.attach.preparing" role="status" className="inline-flex items-center gap-1 text-[11px] text-em-text-2"><Loader size={10} className="em-spin" aria-hidden />{t('ui.agent.composer.attach.preparing')}</span>}
      </div>}
      {nameOnly && (
        <div data-el="agent.chat.attach.note" data-code="EM-4307" role="status" className="mb-1 flex items-start gap-1.5 rounded-[6px] border-l-2 border-em-info bg-em-panel-2 px-2 py-1 text-[12px] text-em-text-2">
          <Info size={12} className="mt-0.5 shrink-0 text-em-info" aria-hidden /><span className="flex-1">{t('ui.agent.composer.attach.nameonly', { model: cap?.label ?? cap?.modelId ?? '' })}</span>
          <button type="button" className="shrink-0 underline" onClick={() => openModelPicker(agent)}>{t('ui.agent.common.switchmodel')}</button>
        </div>
      )}
      {attachError && (
        <div data-el="agent.chat.attach.error" role="alert" className="mb-1 rounded-[6px] border-l-2 border-em-warn bg-em-panel-2 px-2 py-1 text-[12px]">
          <div className="flex items-center gap-1.5"><TriangleAlert size={12} className="text-em-warn" /><span className="flex-1">{t(`err.${attachError.code}.title`)}</span><span className="t-mono text-em-muted">{attachError.code}</span></div>
          <div className="text-em-text-2">{t(`err.${attachError.code}.body`, attachError.vars ?? {})}</div>
          <div className="mt-1 flex gap-2">
            <Button size={28} onClick={() => setAttachError(null)}>{t('ui.common.close')}</Button>
          </div>
        </div>
      )}
      <div className={cx('flex flex-col gap-1 rounded-[8px] border border-em-line bg-em-panel-2 p-1', reason && 'opacity-80', busy && 'border-em-accent/50')}>
        <textarea ref={ref} data-el="agent.chat.composer" data-mode={mode} data-busy={busy ? 'true' : undefined} rows={1} value={value} placeholder={reason ?? (busy ? t('ui.agent.composer.working') : placeholder)} aria-label={t(`a11y.agent.${agent}.composer`)} aria-describedby={reason ? reasonId : undefined}
          readOnly={Boolean(reason)} onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (reason && ((e.key === 'Enter' && !e.shiftKey) || (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey))) explainBlocked();
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); send(); }   /* Enter or Ctrl+Enter sends (FR-153) */
            else if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !value) { e.preventDefault(); setMode(mode === 'brainstorm' ? 'editor' : 'brainstorm'); }
            else if (e.key === 'Backspace' && !value && targets.length && onRemoveTarget) { e.preventDefault(); onRemoveTarget(targets[targets.length - 1]!); }
          }}
          className="min-h-7 w-full resize-none bg-transparent px-1.5 py-1 text-[14px] leading-5 outline-none placeholder:text-em-muted" />
        <div className="flex items-center gap-1">
          <span className="relative">
            <IconButton el="agent.chat.attach" data-popover-trigger="" label={t('ui.agent.composer.attach')} icon={<Paperclip size={16} />} size={28} disabledReason={reason} onClick={() => setAttachOpen((o) => !o)} />
            {attachOpen && (
              <Popover onClose={() => setAttachOpen(false)} width={220} label={t('ui.agent.composer.attach')}>
                <button type="button" data-el="agent.chat.attach.file" className="flex w-full items-center gap-1.5 rounded-[6px] px-2 py-1 text-left hover:bg-em-panel" onClick={() => void pickImage()}><ImagePlus size={14} />{t('ui.agent.composer.attach.file')}</button>
                <button type="button" data-el="agent.chat.attach.audio" aria-label={noEllipsis(t('ui.agent.composer.attach.audio.pick'))} className="flex w-full items-center gap-1.5 rounded-[6px] px-2 py-1 text-left hover:bg-em-panel" onClick={() => void pickFile('audio')}><Music size={14} />{t('ui.agent.composer.attach.audio.pick')}</button>
                <button type="button" data-el="agent.chat.attach.document" aria-label={noEllipsis(t('ui.agent.composer.attach.docs.pick'))} className="flex w-full items-center gap-1.5 rounded-[6px] px-2 py-1 text-left hover:bg-em-panel" onClick={() => void pickFile('document')}><FileText size={14} />{t('ui.agent.composer.attach.docs.pick')}</button>
                <div className="my-1 border-t border-em-line" />
                {images.length === 0 ? <div className="p-2 text-em-muted">{t('ui.agent.composer.attach.none')}</div>
                  : images.map((a) => <button key={a.id} type="button" data-el="agent.chat.attach.asset" className="block w-full truncate rounded-[6px] px-2 py-1 text-left hover:bg-em-panel" onClick={() => { setAttachments((x) => [...new Set([...x, a.id])].slice(0, 4)); setAttachOpen(false); }}>{a.name}</button>)}
              </Popover>
            )}
            <input ref={file} data-el="agent.chat.attach.input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden aria-hidden tabIndex={-1} onChange={(e) => { void attachFile(e.target.files?.[0]); e.target.value = ''; }} />
          </span>
          <span className="flex-1" />
          {chars > COMPOSER_COUNTER_FROM && <span data-el="agent.chat.composer.count" role="status" className={cx('t-mono text-[11px]', tooLong ? 'text-em-danger' : 'text-em-muted')}>{tooLong ? t('ui.agent.composer.toolong', { max: COMPOSER_MAX }) : `${chars} / ${COMPOSER_MAX}`}</span>}
          {busy
            ? <IconButton el="agent.chat.stop" label={t('ui.agent.composer.stop')} icon={<Square size={14} />} size={28} onClick={stop} />
            : <IconButton el="agent.chat.send" label={t('ui.agent.composer.send')} icon={<SendHorizontal size={16} />} size={28} disabledReason={reason ?? (preparing ? t('ui.agent.composer.attach.preparing') : empty ? t('ui.agent.composer.empty') : tooLong ? t('ui.agent.composer.toolong', { max: COMPOSER_MAX }) : null)} onClick={send} />}
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
        {picker && <SectionBoundary section="chat.model-popover" onClose={closePicker} className="absolute left-0 top-full z-30 mt-1 w-[340px]"><ModelPopover agent={agent} onClose={closePicker} /></SectionBoundary>}
      </span>
      <ResearchToggle />
      {agent === 'editor' && cap && !cap.toolCalling && <span className="shrink-0 rounded-[4px] border border-em-line px-1 text-[10px] text-em-muted" title={t('ui.agent.footer.jsonmode')}>JSON</span>}
      {/* Entry 36: "0 / 1 000 000" before the first message squeezed the model name to "Claude S…" at 1280 wide; shown once used */}
      {a && used > 0 && <span data-el="agent.chat.usage" data-tone={tone} role="status" title={usageTip} aria-label={`${t('a11y.agent.footer.ctx', { used: formatTokens(used, lang), limit: limit ? formatTokens(limit, lang) : 'n/a' })}. ${t('ui.agent.footer.ctx.cost', { cost })}`}
        className={cx('t-mono shrink-0 text-[11px]', tone === 'danger' ? 'text-em-danger' : tone === 'warn' ? 'text-em-warn' : 'text-em-muted')}>
        {/* Entry 36: "1.794 / 1.000.000" left "Model: Cl…" at 1280 wide; the share of the context is enough here (full numbers in the tooltip) */}
        {limit ? `${formatNumber(Math.min(100, (used / limit) * 100), lang, used / limit < 0.1 ? 1 : 0)} %` : formatTokens(used, lang)}
      </span>}
      <span title={help} aria-label={help} className="shrink-0 text-em-muted"><CircleHelp size={14} /></span>
      <IconButton el="agent.chat.maximize" size={28} aria-pressed={layout.maximized} label={layout.maximized ? t('ui.agent.chat.restore') : t('ui.agent.chat.maximize.one')}
        icon={layout.maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />} onClick={layout.onToggleMax} />
    </div>
  );
}
