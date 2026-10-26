// Expertmotion app mark (Operator feedback 2026-10-26). Same geometry as apps/desktop/build/expertmotion-mark.svg, which
// apps/desktop/scripts/make-tray-icon.mjs generates together with the tray / app icons; change it there first.
import { useId } from 'react';

export function AppMark({ size = 20, className }: { size?: number; className?: string }) {
  const id = `em-mark-${useId().replace(/:/g, '')}`;
  return (
    <svg data-el-mark="" viewBox="0 0 64 64" width={size} height={size} className={className} aria-hidden focusable="false">
      <defs><linearGradient id={id} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#f09c48" /><stop offset="1" stopColor="#b05218" /></linearGradient></defs>
      <rect width="64" height="64" rx="14" fill={`url(#${id})`} />
      <g opacity={0.42}><polygon points="16,21 33,32 16,43" fill="#fff" stroke="#fff" strokeWidth={5} strokeLinejoin="round" /></g>
      <polygon points="27,18 48,32 27,46" fill="#fff" stroke="#fff" strokeWidth={6} strokeLinejoin="round" />
    </svg>
  );
}
