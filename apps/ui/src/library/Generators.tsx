// Generator Cards (lib.generator.card.*, Tools mode; P1/P2 per ADR-016). Each opens its scr.generate.* sheet.
// FR-100: the card shows the required model, its installed state and size, a hardware tier hint and the priority tag; "Coming soon"
// only when the Local Service reports the kind as not enabled in this build (R-135), never from a hard-coded list.
import { Captions, Hash, Image as ImageIcon, Mic, Music2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useStore } from '../state/store.js';
import type { GeneratorCardDto } from '../api/types.js';
import { Badge, cx } from '../components/ui.js';
import { formatBytes } from '../i18n/index.js';

export type GeneratorKind = 'voice' | 'captions' | 'music' | 'thumbnail' | 'hashtags';
/** Fallback model keys when R-135 is unavailable (older service); the service is the source of truth. */
export const GENERATOR_MODEL: Partial<Record<GeneratorKind, string>> = { voice: 'piper-id-news', captions: 'whisper-small' };
const ICONS: Record<GeneratorKind, ReactNode> = { voice: <Mic size={20} />, captions: <Captions size={20} />, music: <Music2 size={20} />, thumbnail: <ImageIcon size={20} />, hashtags: <Hash size={20} /> };
const ORDER: GeneratorKind[] = ['voice', 'captions', 'music', 'thumbnail', 'hashtags'];

/** R-135 cards, refreshed whenever the Model Manager state changes (install/remove/progress). */
export function useGeneratorCards(): GeneratorCardDto[] | null {
  const { runtime, state } = useStore();
  const [cards, setCards] = useState<GeneratorCardDto[] | null>(null);
  const modelsKey = state.models.map((m) => `${m.key}:${m.status}`).join(',');
  useEffect(() => {
    let alive = true;
    runtime.api.listGenerators().then((r) => { if (alive) setCards(r.items); }).catch(() => { if (alive) setCards(null); });
    return () => { alive = false; };
  }, [runtime, modelsKey]);
  return cards;
}

export function Generators() {
  const { state, actions, t, lang } = useStore();
  const cards = useGeneratorCards();
  useEffect(() => { if (!state.models.length) void actions.loadModels(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="grid grid-cols-1 gap-2">
      {ORDER.map((kind) => {
        const card = cards?.find((c) => c.kind === kind);
        const priority = card?.priority ?? (kind === 'music' || kind === 'thumbnail' ? 'P2' : 'P1');
        const modelKey = card?.model?.key ?? GENERATOR_MODEL[kind];
        const installed = card ? (card.llm || Boolean(card.model?.installed) || card.models.some((m) => m.installed))
          : kind === 'hashtags' || !modelKey || state.models.some((m) => m.key === modelKey && m.status === 'installed');
        const comingSoon = card ? !card.enabled : false;
        const privateBlocked = kind === 'hashtags' && state.settings?.privateMode;
        const model = card?.model ?? null;
        return (
          <button key={kind} type="button" data-el={`lib.generator.card.${kind}`} data-enabled={card ? String(card.enabled) : undefined} data-installed={String(installed)}
            onClick={() => actions.setScreen({ kind: 'generate', generator: kind })}
            aria-describedby={privateBlocked ? `gen-${kind}-reason` : undefined}
            className={cx('flex items-start gap-3 rounded-[8px] border border-em-line bg-em-panel p-3 text-left hover:border-em-line-strong em-trans', (privateBlocked || comingSoon) && 'opacity-60')}>
            <span className="mt-0.5 text-em-accent">{ICONS[kind]}</span>
            <span className="flex flex-1 flex-col gap-1">
              <span className="font-semibold">{t(`ui.lib.generator.${kind}.title`)}</span>
              <span className="text-em-muted">{t(`ui.lib.generator.${kind}.subtitle`)}</span>
              {card && !card.llm && model && (
                <span className="text-[12px] text-em-text-2">{t('ui.lib.generator.model', { model: model.label, size: model.bytes ? formatBytes(model.bytes, lang) : t('ui.lib.generator.nodownload') })}</span>
              )}
              {card?.llm && <span className="text-[12px] text-em-text-2">{t('ui.lib.generator.llm', { model: state.assignments?.brainstorm?.modelId ?? t('ui.agent.footer.nomodel') })}</span>}
              <span className="flex flex-wrap gap-1">
                <Badge>{priority}</Badge>
                {comingSoon && <Badge>{t('ui.lib.catalogue.comingsoon')}</Badge>}
                {!comingSoon && !installed && <Badge tone="info">{t('ui.lib.generator.needsmodel')}</Badge>}
                {!comingSoon && installed && !card?.llm && <Badge tone="success">{t('ui.lib.generator.installed')}</Badge>}
                {card?.tierHint === 'slow' && <Badge tone="warn">{t('ui.lib.generator.tier.slow', { tier: card.tier ?? '' })}</Badge>}
                {privateBlocked && <Badge tone="private"><span id={`gen-${kind}-reason`}>{t('ui.lib.generator.private')}</span></Badge>}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
