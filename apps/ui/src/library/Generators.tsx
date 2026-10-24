// Generator Cards (lib.generator.card.*, Tools mode; P1/P2 per ADR-016). Each opens its scr.generate.* sheet.
import { Captions, Hash, Image as ImageIcon, Mic, Music2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useStore } from '../state/store.js';
import { Badge, cx } from '../components/ui.js';

export type GeneratorKind = 'voice' | 'captions' | 'music' | 'thumbnail' | 'hashtags';
export const GENERATOR_MODEL: Partial<Record<GeneratorKind, string>> = { voice: 'piper-id-news', captions: 'whisper-small' };

export function Generators() {
  const { state, actions, t } = useStore();
  const cards: Array<{ kind: GeneratorKind; icon: ReactNode; priority: 'P1' | 'P2' }> = [
    { kind: 'voice', icon: <Mic size={20} />, priority: 'P1' }, { kind: 'captions', icon: <Captions size={20} />, priority: 'P1' },
    { kind: 'music', icon: <Music2 size={20} />, priority: 'P2' }, { kind: 'thumbnail', icon: <ImageIcon size={20} />, priority: 'P2' },
    { kind: 'hashtags', icon: <Hash size={20} />, priority: 'P1' },
  ];
  return (
    <div className="grid grid-cols-1 gap-2">
      {cards.map((c) => {
        const modelKey = GENERATOR_MODEL[c.kind];
        const needsModel = modelKey ? !state.models.some((m) => m.key === modelKey && m.status === 'installed') : false;
        const privateBlocked = c.kind === 'hashtags' && state.settings?.privateMode;
        return (
          <button key={c.kind} type="button" data-el={`lib.generator.card.${c.kind}`} onClick={() => actions.setScreen({ kind: 'generate', generator: c.kind })}
            aria-describedby={privateBlocked ? `gen-${c.kind}-reason` : undefined}
            className={cx('flex items-start gap-3 rounded-[8px] border border-em-line bg-em-panel p-3 text-left hover:border-em-line-strong em-trans', privateBlocked && 'opacity-60')}>
            <span className="mt-0.5 text-em-accent">{c.icon}</span>
            <span className="flex flex-1 flex-col gap-1">
              <span className="font-semibold">{t(`ui.lib.generator.${c.kind}.title`)}</span>
              <span className="text-em-muted">{t(`ui.lib.generator.${c.kind}.subtitle`)}</span>
              <span className="flex flex-wrap gap-1">
                {c.priority === 'P2' && <Badge>{t('ui.lib.catalogue.comingsoon')}</Badge>}
                {needsModel && <Badge tone="info">{t('ui.lib.generator.needsmodel')}</Badge>}
                {privateBlocked && <Badge tone="private"><span id={`gen-${c.kind}-reason`}>{t('ui.lib.generator.private')}</span></Badge>}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
