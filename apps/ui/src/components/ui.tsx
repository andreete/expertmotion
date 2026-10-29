// UI kit (UI_UX_SPECIFICATION.md §3 CMP-01 … CMP-20). Every interactive element takes an `el` prop rendered as `data-el`.
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Loader, X } from 'lucide-react';
import { useT } from '../i18n/index.js';

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');
export { cx };

type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost';
export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'> {
  el?: string; variant?: BtnVariant; size?: 28 | 32 | 36; icon?: ReactNode; loading?: boolean;
  /** Disabled with a reason: kept focusable with aria-disabled so the reason is reachable (A11Y-08). */
  disabledReason?: string | null; disabled?: boolean;
  /** FR-264: tooltip text (hover after a short delay, keyboard focus at once; TooltipLayer). A disabled reason wins. */
  tip?: string;
}
const VARIANT: Record<BtnVariant, string> = {
  primary: 'bg-em-accent text-em-accent-ink hover:bg-em-accent-hover font-semibold',
  secondary: 'bg-em-panel-2 border border-em-line hover:border-em-line-strong text-em-text',
  ghost: 'bg-transparent hover:bg-em-panel-2 text-em-text-2',
  danger: 'bg-em-danger text-white hover:brightness-110 font-semibold',
  'danger-ghost': 'bg-transparent text-em-danger hover:bg-em-panel-2',
};
export function Button({ el, variant = 'secondary', size = 32, icon, loading, disabledReason, disabled, className, children, onClick, title, tip, ...rest }: ButtonProps) {
  const isDisabled = Boolean(disabled || disabledReason);
  const descId = useId();
  return (
    <button
      type="button" data-el={el} aria-disabled={isDisabled || undefined} aria-describedby={disabledReason ? descId : undefined}
      title={disabledReason ?? title} data-tip={disabledReason ?? tip}
      className={cx('inline-flex items-center justify-center gap-1.5 rounded-[6px] px-3 whitespace-nowrap em-trans', VARIANT[variant], isDisabled && 'opacity-40 cursor-not-allowed', className)}
      style={{ height: size, minHeight: size }}
      onClick={(e) => { if (isDisabled || loading) { e.preventDefault(); return; } onClick?.(e); }}
      {...rest}
    >
      {loading ? <Loader size={16} className="em-spin" aria-hidden /> : icon}
      {children}
      {disabledReason && <span id={descId} className="sr-only">{disabledReason}</span>}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'variant'> { label: string; active?: boolean; size?: 28 | 32; badge?: ReactNode }
export function IconButton({ label, active, icon, size = 32, className, badge, ...rest }: IconButtonProps) {
  return (
    <Button {...rest} variant="ghost" size={size} aria-label={label} title={rest.disabledReason ?? label} icon={icon}
      className={cx('relative !px-0', active && '!bg-em-panel-2 !text-em-accent', className)} style={{ width: size }}>
      {badge}
    </Button>
  );
}

export function Spinner({ size = 16, label }: { size?: number; label?: string }) {
  return <span className="inline-flex items-center gap-2 text-em-muted"><Loader size={size} className="em-spin" aria-hidden />{label}</span>;
}

export function Progress({ value, el, label, tone = 'accent' }: { value: number | null; el?: string; label?: string; tone?: 'accent' | 'danger' | 'success' }) {
  const pct = value === null ? null : Math.round(Math.max(0, Math.min(1, value)) * 100);
  const color = tone === 'danger' ? 'bg-em-danger' : tone === 'success' ? 'bg-em-success' : 'bg-em-accent';
  return (
    <div data-el={el} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined} className="h-1.5 w-full rounded-full bg-em-panel-2 overflow-hidden">
      <div className={cx('h-full', color, pct === null && 'w-1/3 em-skeleton')} style={pct === null ? undefined : { width: `${pct}%` }} />
    </div>
  );
}

export type BadgeTone = 'neutral' | 'accent' | 'accent-2' | 'success' | 'warn' | 'danger' | 'info' | 'private';
const TONE: Record<BadgeTone, string> = {
  neutral: 'text-em-text-2 border-em-line', accent: 'text-em-accent border-em-accent/50', 'accent-2': 'text-em-accent-2 border-em-accent-2/50', success: 'text-em-success border-em-success/50',
  warn: 'text-em-warn border-em-warn/50', danger: 'text-em-danger border-em-danger/50', info: 'text-em-info border-em-info/50', private: 'text-em-private border-em-private/50',
};
export function Badge({ tone = 'neutral', icon, children, el, title }: { tone?: BadgeTone; icon?: ReactNode; children: ReactNode; el?: string; title?: string }) {
  return <span data-el={el} title={title} className={cx('inline-flex items-center gap-1 rounded-[4px] border px-1.5 text-[11px] leading-[18px] whitespace-nowrap bg-em-panel', TONE[tone])}>{icon}{children}</span>;
}

export function Toggle({ checked, onChange, label, el, tone = 'accent', help, disabledReason }: { checked: boolean; onChange: (v: boolean) => void; label: string; el?: string; tone?: 'accent' | 'private'; help?: ReactNode; disabledReason?: string | null }) {
  const on = tone === 'private' ? 'bg-em-private' : 'bg-em-accent';
  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" role="switch" aria-checked={checked} aria-label={label} data-el={el} aria-disabled={disabledReason ? true : undefined} title={disabledReason ?? label}
        onClick={() => { if (!disabledReason) onChange(!checked); }}
        className={cx('relative h-5 w-9 rounded-full em-trans border border-em-line', checked ? on : 'bg-em-panel-2', disabledReason && 'opacity-40 cursor-not-allowed')}>
        <span className={cx('absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white em-trans', checked ? 'left-[18px]' : 'left-0.5')} />
      </button>
      {help}
    </span>
  );
}

export interface SegmentOption<V extends string> { value: V; label: ReactNode; sub?: ReactNode; el: string; disabledReason?: string | null; warn?: string | null; aria?: string; glyph?: ReactNode }
export function Segmented<V extends string>({ options, value, onChange, label, cols, size = 'md' }: { options: SegmentOption<V>[]; value: V | null; onChange: (v: V) => void; label: string; cols?: number; size?: 'sm' | 'md' }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  const move = (d: number) => { const n = (idx + d + options.length) % options.length; refs.current[n]?.focus(); };
  return (
    <div role="radiogroup" aria-label={label} className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${cols ?? options.length}, minmax(0, 1fr))` }}
      onKeyDown={(e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(1); } if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(-1); } }}>
      {options.map((o, i) => {
        const active = o.value === value;
        return (
          <button key={o.value} ref={(r) => { refs.current[i] = r; }} type="button" role="radio" aria-checked={active} aria-label={o.aria} data-el={o.el}
            aria-disabled={o.disabledReason ? true : undefined} tabIndex={active || (value === null && i === 0) ? 0 : -1} title={o.disabledReason ?? o.warn ?? undefined}
            onClick={() => { if (!o.disabledReason) onChange(o.value); }}
            className={cx('relative flex flex-col items-center justify-center rounded-[6px] border px-1 em-trans', size === 'sm' ? 'py-1' : 'py-1.5',
              active ? 'bg-em-panel-2 border-em-accent text-em-accent' : 'border-em-line text-em-text-2 hover:border-em-line-strong', o.disabledReason && 'opacity-40 cursor-not-allowed')}>
            {o.glyph}
            <span className="text-[12px] font-medium leading-4">{o.label}</span>
            {o.sub && <span className="t-mono text-[10px] text-em-muted leading-3">{o.sub}</span>}
            {o.warn && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-em-warn" aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}

/** CMP-10 Modal: focus trapped, Esc closes (unless blocking), focus returns to the opener. */
/** Open modals, innermost last (only the topmost handles Esc when focus is on <body>). */
const MODAL_STACK: object[] = [];
export function Modal({ el, title, children, footer, onClose, width = 560, blocking, sheet, labelledBy }: {
  el: string; title: ReactNode; children: ReactNode; footer?: ReactNode; onClose: () => void; width?: number; blocking?: boolean; sheet?: boolean; labelledBy?: string;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const first = node?.querySelector<HTMLElement>('input, textarea, select, button:not([data-close]), [tabindex="0"]');
    (first ?? node)?.focus();
    return () => { opener?.focus?.(); };
  }, []);
  // Entry 28: after Save / Test the pressed button is disabled and focus falls back to <body>, where the dialog's own onKeyDown
  // never sees Esc. The topmost open modal closes on Esc then too (and takes focus back so Tab stays inside).
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const me = {}; MODAL_STACK.push(me);
    const on = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || blocking || MODAL_STACK[MODAL_STACK.length - 1] !== me) return;
      const a = document.activeElement;
      if (a && a !== document.body && a !== document.documentElement) return;          // focus inside: handled by onKeyDown
      e.preventDefault(); closeRef.current();
    };
    document.addEventListener('keydown', on);
    return () => { document.removeEventListener('keydown', on); const i = MODAL_STACK.indexOf(me); if (i >= 0) MODAL_STACK.splice(i, 1); };
  }, [blocking]);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && !blocking) { e.stopPropagation(); onClose(); return; }
    if (e.key !== 'Tab' || !ref.current) return;
    const f = [...ref.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute('disabled'));
    if (!f.length) return;
    const first = f[0]!, last = f[f.length - 1]!;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  return (
    <div className="fixed inset-0 z-[60] flex" style={{ background: 'var(--em-overlay)' }} onMouseDown={(e) => { if (e.target === e.currentTarget && !blocking) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={labelledBy ?? titleId} data-el={el} tabIndex={-1} onKeyDown={onKey}
        className={cx('flex flex-col bg-em-panel border border-em-line text-em-text', sheet ? 'ml-auto h-full' : 'm-auto max-h-[90vh] rounded-[12px]')}
        style={{ width: `min(${width}px, 100vw)`, boxShadow: 'var(--sh-3)' }}>
        <div className="flex items-center gap-2 border-b border-em-line px-4 py-3">
          <h2 id={titleId} className="flex-1 text-[16px] font-semibold leading-[22px]">{title}</h2>
          {!blocking && <IconButton label={t('ui.common.close')} icon={<X size={16} />} onClick={onClose} size={28} data-close="" />}
        </div>
        <div className="flex-1 overflow-auto px-4 py-3">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-em-line px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/** Anchored popover / menu container; Esc and outside click close; focus returns to the trigger. */
export function Popover({ el, onClose, children, align = 'left', width, role = 'dialog', label }: { el?: string; onClose: () => void; children: ReactNode; align?: 'left' | 'right'; width?: number; role?: 'dialog' | 'menu'; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('button, input, [tabindex="0"]')?.focus();
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('[data-popover-trigger]')) onClose(); };
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('mousedown', onDown); opener?.focus?.(); };
  }, [onClose]);
  return (
    <div ref={ref} data-el={el} role={role} aria-label={label}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
        if (role === 'menu' && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
          e.preventDefault();
          const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
          const i = items.indexOf(document.activeElement as HTMLElement);
          items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
        }
      }}
      className={cx('absolute top-full z-30 mt-1 rounded-[8px] border border-em-line bg-em-panel p-1 text-em-text', align === 'right' ? 'right-0' : 'left-0')}
      style={{ boxShadow: 'var(--sh-2)', width }}>
      {children}
    </div>
  );
}

export function MenuItem({ el, onClick, children, shortcut, disabledReason, badge }: { el: string; onClick: () => void; children: ReactNode; shortcut?: string; disabledReason?: string | null; badge?: ReactNode }) {
  return (
    <button type="button" role="menuitem" data-el={el} aria-disabled={disabledReason ? true : undefined} title={disabledReason ?? undefined}
      onClick={() => { if (!disabledReason) onClick(); }}
      className={cx('flex w-full items-center gap-3 rounded-[6px] px-2.5 py-1.5 text-left hover:bg-em-panel-2', disabledReason && 'opacity-40 cursor-not-allowed')}>
      <span className="flex-1">{children}</span>{badge}
      {shortcut && <span className="t-mono text-em-muted">{shortcut}</span>}
    </button>
  );
}

export function Field({ label, children, hint, error, htmlFor }: { label: ReactNode; children: ReactNode; hint?: ReactNode; error?: ReactNode; htmlFor?: string }) {
  return (
    <div className="mb-3 flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-[12px] font-medium text-em-text-2">{label}</label>
      {children}
      {error ? <span className="text-[12px] text-em-danger">{error}</span> : hint ? <span className="text-[12px] text-em-muted">{hint}</span> : null}
    </div>
  );
}
export const inputCls = 'h-8 w-full rounded-[6px] border border-em-line bg-em-panel-2 px-2.5 text-[13px] text-em-text placeholder:text-em-muted focus:border-em-line-strong outline-none';

export function Empty({ icon, title, body, action, el }: { icon?: ReactNode; title: ReactNode; body?: ReactNode; action?: ReactNode; el?: string }) {
  return (
    <div data-el={el} className="flex flex-col items-center justify-center gap-2 p-4 text-center">
      {icon && <span className="text-em-muted">{icon}</span>}
      <div className="text-[14px] font-semibold">{title}</div>
      {body && <div className="max-w-[260px] text-em-muted">{body}</div>}
      {action}
    </div>
  );
}

/** Inline error (UI_UX_SPECIFICATION.md §9): danger border, title/body from err.<code>, code in mono, optional actions. */
export function ErrorBox({ code, el, actions, vars }: { code: string; el?: string; actions?: ReactNode; vars?: Record<string, string | number> }) {
  const t = useT();
  return (
    <div data-el={el} role="alert" className="rounded-[6px] border-l-2 border-em-danger bg-em-panel-2 px-3 py-2">
      <div className="flex items-center gap-2"><span className="flex-1 font-semibold">{t(`err.${code}.title`, vars)}</span><span className="t-mono text-em-muted select-all">{code}</span></div>
      <div className="text-em-text-2">{t(`err.${code}.body`, vars)}</div>
      {actions && <div className="mt-2 flex gap-2">{actions}</div>}
    </div>
  );
}

export function SectionLabel({ children, right, el }: { children: ReactNode; right?: ReactNode; el?: string }) {
  return <div data-el={el} className="flex items-center gap-2 px-1 py-1"><span className="t-label flex-1">{children}</span>{right}</div>;
}
