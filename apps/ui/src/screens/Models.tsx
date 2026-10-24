// Model Manager (scr.models): local models with size, licence, tier, install/remove, download progress (ADR-008, F11).
import { useEffect } from 'react';
import { useStore } from '../state/store.js';
import { Badge, Button, Modal, Progress } from '../components/ui.js';
import { formatBytes } from '../i18n/index.js';

export function ModelsScreen({ onClose }: { onClose: () => void }) {
  const { state, runtime, actions, t, lang } = useStore();
  useEffect(() => { void actions.loadModels(); }, [actions]);
  const tier = state.hardware?.tier ?? 'T0';
  const priv = Boolean(state.settings?.privateMode);
  const engines = [...new Set(state.models.map((m) => m.engine))];
  const act = (p: Promise<unknown>) => { void p.then(() => actions.loadModels()).catch(actions.error); };
  return (
    <Modal el="scr.models" sheet width={640} title={t('ui.scr.models.title')} onClose={onClose}>
      <div data-el="scr.models.tier" className="mb-3 rounded-[8px] border border-em-line p-2">{t('ui.scr.models.tier', { tier, desc: t(`ui.scr.models.tier.${tier}`) })}</div>
      {priv && <p className="mb-2 text-em-private">{t('err.EM-8202.title')}</p>}
      <div data-el="scr.models.list" className="flex flex-col gap-3">
        {engines.map((engine) => (
          <div key={engine}>
            <div className="t-label mb-1">{engine}</div>
            {state.models.filter((m) => m.engine === engine).map((m) => {
              const fits = m.tiers.includes(tier);
              return (
                <div key={m.key} data-el="scr.models.row" data-model-key={m.key} className="mb-1 flex flex-col gap-1 rounded-[6px] border border-em-line p-2">
                  <div className="flex items-center gap-2">
                    <span className="flex-1 font-medium">{m.label}</span>
                    <Badge>{t(`ui.scr.models.task.${m.task}`)}</Badge>
                    <span className="t-mono text-em-muted">{formatBytes(m.bytesTotal, lang)}</span>
                    <a href={m.licence.url} target="_blank" rel="noreferrer" className="text-[12px] text-em-accent underline">{m.licence.name}</a>
                    <Badge tone={fits ? 'neutral' : 'warn'}>{t('ui.scr.models.mintier', { tier: m.tiers[0] ?? 'T0' })}</Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="flex-1 text-[12px] text-em-muted">{t(`ui.scr.models.status.${m.status}`)}{m.errorCode ? ` · ${m.errorCode}` : ''}</span>
                    {m.status === 'installed' && <Button el="scr.models.row.remove" size={28} variant="danger-ghost" onClick={() => act(runtime.api.removeModel(m.key))}>{t('ui.common.remove')}</Button>}
                    {(m.status === 'not-installed' || m.status === 'failed') && (
                      <Button el="scr.models.row.install" size={28} variant="primary" disabledReason={priv ? t('err.EM-8202.title') : !fits ? t('ui.scr.models.notier') : null} onClick={() => act(runtime.api.installModel(m.key))}>{t('ui.scr.models.install')}</Button>
                    )}
                    {(m.status === 'downloading' || m.status === 'verifying') && <Button size={28} variant="ghost" onClick={() => act(runtime.api.cancelModel(m.key))}>{t('ui.common.cancel')}</Button>}
                  </div>
                  {(m.status === 'downloading' || m.status === 'verifying') && (
                    <div data-el="scr.models.row.progress" className="flex items-center gap-2">
                      <Progress value={m.bytesTotal ? m.bytesDone / m.bytesTotal : null} label={m.label} />
                      <span className="t-mono shrink-0 text-[11px] text-em-muted">{formatBytes(m.bytesDone, lang)} / {formatBytes(m.bytesTotal, lang)}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </Modal>
  );
}
