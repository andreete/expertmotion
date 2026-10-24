// Hardware Monitor popover (scr.hardware): CPU, RAM, process memory, disk, GPU, workload. Refreshes every 2 s while open
// by polling R-152 (the SSE `hardware.tick` stream needs a second EventSource with ?hardware=1; polling is equivalent here).
import { useEffect } from 'react';
import { useStore } from '../state/store.js';
import { Popover } from '../components/ui.js';
import { formatNumber } from '../i18n/index.js';

export function HardwarePopover({ onClose }: { onClose: () => void }) {
  const { state, runtime, dispatch, t, lang } = useStore();
  useEffect(() => {
    let alive = true;
    const pull = () => runtime.api.hardwareLive().then((tick) => { if (alive) dispatch({ type: 'tick', tick }); }).catch(() => undefined);
    void pull();
    const h = setInterval(pull, 2000);
    return () => { alive = false; clearInterval(h); };
  }, [runtime, dispatch]);
  const k = state.tick, p = state.hardware;
  const gb = (mb: number) => formatNumber(mb / 1024, lang, 1);
  const rows: Array<[string, string, string]> = [
    ['scr.hardware.cpu', t('ui.scr.hardware.cpu'), k ? `${Math.round(k.cpuPercent)} %` : '…'],
    ['scr.hardware.ram', t('ui.scr.hardware.ram'), k ? `${gb(k.ramTotalMb - k.ramFreeMb)} / ${gb(k.ramTotalMb)} GB` : '…'],
    ['scr.hardware.procmem', t('ui.scr.hardware.procmem'), k ? `${k.processMb + (k.chromeMb ?? 0)} MB` : '…'],
    ['scr.hardware.disk', t('ui.scr.hardware.disk'), k?.diskFreeMb != null ? `${gb(k.diskFreeMb)} GB` : '…'],
    ['scr.hardware.gpu', t('ui.scr.hardware.gpu'), p ? (p.gpuModel ? `${p.gpuModel}${k?.gpuPercent != null ? ` · ${k.gpuPercent} %` : ''}` : t('ui.scr.hardware.gpu.none')) : '…'],
    ['scr.hardware.workload', t('ui.scr.hardware.workload'), k ? [k.workload.rendering ? t('ui.scr.hardware.rendering') : t('ui.scr.hardware.renderidle'), t('ui.scr.hardware.ingest', { n: k.workload.ingesting }), t('ui.scr.hardware.downloads', { n: k.workload.downloading })].join(' · ') : '…'],
  ];
  return (
    <Popover el="scr.hardware" onClose={onClose} align="right" width={320} label={t('ui.hdr.action.hardware')}>
      <div className="p-2">
        <div className="t-label mb-2">{t('ui.hdr.action.hardware')}</div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {rows.map(([el, label, value]) => <div key={el} data-el={el} className="contents"><dt className="text-em-muted">{label}</dt><dd className="t-mono text-right">{value}</dd></div>)}
        </dl>
        <p className="mt-2 text-[11px] text-em-muted">{t('ui.scr.hardware.footer', { tier: p?.tier ?? 'T0' })}</p>
      </div>
    </Popover>
  );
}
