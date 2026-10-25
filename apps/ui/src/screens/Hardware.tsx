// Hardware Monitor popover (scr.hardware, FR-127…FR-130): CPU, RAM, Expertmotion memory (Service + engine children),
// data and output drives, GPU and VRAM, Hardware Tier with its consequences and Re-check, and the workload list with
// Cancel and "paused during render". Refreshes every 2 s while open by polling R-152 (the SSE `hardware.tick` stream
// needs a second EventSource with ?hardware=1; polling is equivalent here and stops when the popover closes).
import { useEffect, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { useStore } from '../state/store.js';
import type { WorkloadItemDto } from '../api/types.js';
import { Button, IconButton, Popover, Progress } from '../components/ui.js';
import { formatNumber } from '../i18n/index.js';
import { EmError } from '@expertmotion/shared';

function WorkloadItem({ item }: { item: WorkloadItemDto }) {
  const { runtime, actions, t, lang } = useStore();
  const pct = item.progress === null ? null : Math.round(item.progress * 100);
  const label = item.displayName?.[lang] ?? item.label;                                              // downloads: the model's product name
  const text = item.pausedReason === 'render' || item.status === 'paused' ? t('ui.scr.hardware.item.paused', { name: label })
    : item.status === 'queued' ? t('ui.scr.hardware.item.queued', { name: item.kind === 'generator' ? t(`ui.scr.hardware.gen.${item.label}`) : label })
    : item.kind === 'render' ? t('ui.scr.hardware.item.render', { name: item.label, percent: pct ?? 0 })
    : item.kind === 'download' ? t('ui.scr.hardware.item.download', { name: label, percent: pct ?? 0 })
    : item.kind === 'ingest' ? t('ui.scr.hardware.item.ingest', { name: item.label })
    : item.kind === 'generator' ? t('ui.scr.hardware.item.generator', { name: t(`ui.scr.hardware.gen.${item.label}`), percent: pct ?? 0 })
    : t('ui.scr.hardware.item.agent', { name: t(`ui.scr.providers.assign.${item.label}`) });
  const cancel = () => {
    const p = item.kind === 'render' ? runtime.api.cancelRender(item.id) : item.kind === 'download' ? runtime.api.cancelModel(item.id)
      : item.kind === 'generator' ? runtime.api.cancelGeneratorJob(item.id) : item.kind === 'agent' ? runtime.api.cancelAgentRun(item.id) : null;
    if (p) void p.catch(actions.error);
  };
  return (
    <li data-el="scr.hardware.workload.item" data-kind={item.kind} data-status={item.status} className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1">
        <span className="flex-1 truncate">{text}</span>
        {item.cancellable && <IconButton el="scr.hardware.workload.cancel" label={t('ui.common.cancel')} icon={<X size={12} />} size={28} onClick={cancel} />}
      </div>
      {pct !== null && item.status !== 'paused' && <Progress value={item.progress} label={text} />}
    </li>
  );
}

export function HardwarePopover({ onClose }: { onClose: () => void }) {
  const { state, runtime, dispatch, actions, t, lang } = useStore();
  const [recheck, setRecheck] = useState<'busy' | string | null>(null);
  useEffect(() => {
    let alive = true;
    const pull = () => runtime.api.hardwareLive().then((tick) => { if (alive) dispatch({ type: 'tick', tick }); }).catch(() => undefined);
    void pull();
    const h = setInterval(pull, 2000);
    return () => { alive = false; clearInterval(h); };
  }, [runtime, dispatch]);
  const k = state.tick, p = state.hardware;
  const gb = (mb: number) => formatNumber(mb / 1024, lang, 1);
  const tier = p?.tier ?? 'T0';
  const doRecheck = async () => {                                                                 // FR-129 (R-151, 30 s rate limit → EM-9005)
    setRecheck('busy');
    try { dispatch({ type: 'globals', hardware: await runtime.api.refreshHardware() }); setRecheck(null); void actions.loadModels(); }
    catch (e) { setRecheck(e instanceof EmError ? e.code : 'EM-9001'); }
  };
  // FR-127: Expertmotion = Shell (Electron) + Service + Engine children; a part not measured on this platform shows "—"
  const procTitle = k ? t('ui.scr.hardware.procmem.detail', { shell: k.shellMb ?? '—', service: k.processMb, engine: k.chromeMb ?? '—' }) : undefined;
  const rows: Array<[string, string, string, (string | undefined)?]> = [
    ['scr.hardware.cpu', t('ui.scr.hardware.cpu'), k ? `${Math.round(k.cpuPercent)} %` : '…'],
    ['scr.hardware.ram', t('ui.scr.hardware.ram'), k ? `${gb(k.ramTotalMb - k.ramFreeMb)} / ${gb(k.ramTotalMb)} GB` : '…'],
    ['scr.hardware.procmem', t('ui.scr.hardware.procmem'), k ? `${k.processMb + (k.chromeMb ?? 0) + (k.shellMb ?? 0)} MB` : '…', procTitle],
    ['scr.hardware.disk', t('ui.scr.hardware.disk'), k?.diskFreeMb != null ? `${gb(k.diskFreeMb)} GB` : '…'],
    ['scr.hardware.output', t('ui.scr.hardware.output'), k?.outputDiskFreeMb != null ? `${gb(k.outputDiskFreeMb)} GB` : '…'],
    ['scr.hardware.gpu', t('ui.scr.hardware.gpu'), p ? (p.gpuModel ? `${p.gpuModel}${k?.gpuPercent != null ? ` · ${k.gpuPercent} %` : ''}` : t('ui.scr.hardware.gpu.none')) : '…'],
    ['scr.hardware.vram', t('ui.scr.hardware.vram'), p ? (p.vramMb != null ? `${gb(p.vramMb)} GB` : t('ui.scr.hardware.gpu.none')) : '…'],
  ];
  const items = k?.workload.items ?? [];
  return (
    <Popover el="scr.hardware" onClose={onClose} align="right" width={340} label={t('ui.hdr.action.hardware')}>
      <div className="p-2">
        <div className="t-label mb-2">{t('ui.hdr.action.hardware')}</div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {rows.map(([el, label, value, title]) => <div key={el} data-el={el} className="contents"><dt className="text-em-muted">{label}</dt><dd className="t-mono text-right" title={title}>{value}</dd></div>)}
        </dl>
        <div data-el="scr.hardware.tier" className="mt-2 flex items-start gap-2 rounded-[6px] bg-em-panel-2 p-2 text-[12px]">
          <span className="flex-1">{t('ui.scr.hardware.tierline', { tier, desc: t(`ui.scr.hardware.tier.${tier}`) })}</span>
          <Button el="scr.hardware.recheck" size={28} variant="ghost" icon={<RefreshCw size={12} />} loading={recheck === 'busy'} onClick={() => void doRecheck()}>{t('ui.scr.hardware.recheck')}</Button>
        </div>
        {recheck && recheck !== 'busy' && <p role="status" className="mt-1 text-[12px] text-em-warn">{t(`err.${recheck}.title`)} <span className="t-mono text-em-muted">{recheck}</span></p>}
        <div className="t-label mb-1 mt-3">{t('ui.scr.hardware.workload')}</div>
        <ul data-el="scr.hardware.workload" className="flex flex-col gap-1 text-[12px]">
          {items.length === 0 && <li className="text-em-muted">{k ? t('ui.scr.hardware.idle') : '…'}</li>}
          {items.map((i) => <WorkloadItem key={`${i.kind}:${i.id}`} item={i} />)}
        </ul>
        <p className="mt-2 text-[11px] text-em-muted">{t('ui.scr.hardware.footer', { tier })}</p>
      </div>
    </Popover>
  );
}
