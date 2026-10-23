// preset:transition.* → @remotion/transitions presentation (all 19 exist in the pinned 4.0.535; REMOTION_CAPABILITY_MAP §B).
import type { TransitionPresentation } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { slide } from '@remotion/transitions/slide';
import { wipe } from '@remotion/transitions/wipe';
import { flip } from '@remotion/transitions/flip';
import { clockWipe } from '@remotion/transitions/clock-wipe';
import { iris } from '@remotion/transitions/iris';
import { pushCut } from '@remotion/transitions/push-cut';
import { bookFlip } from '@remotion/transitions/book-flip';
import { zoomBlur } from '@remotion/transitions/zoom-blur';
import { dreamyZoom } from '@remotion/transitions/dreamy-zoom';
import { filmBurn } from '@remotion/transitions/film-burn';
import { linearBlur } from '@remotion/transitions/linear-blur';
import { zoomInOut } from '@remotion/transitions/zoom-in-out';
import { dissolve } from '@remotion/transitions/dissolve';
import { ripple } from '@remotion/transitions/ripple';
import { crosswarp } from '@remotion/transitions/crosswarp';
import { crossZoom } from '@remotion/transitions/cross-zoom';
import { swap } from '@remotion/transitions/swap';
import { blurSlide } from '@remotion/transitions/blur-slide';
import { none } from '@remotion/transitions/none';

type Dir = 'from-left' | 'from-right' | 'from-top' | 'from-bottom';
type Factory = (params: Record<string, unknown>, dims: { width: number; height: number }) => TransitionPresentation<Record<string, unknown>>;
const any = (p: unknown) => p as TransitionPresentation<Record<string, unknown>>;
const dir = (p: Record<string, unknown>, d: Dir): Dir => (['from-left', 'from-right', 'from-top', 'from-bottom'].includes(String(p['direction'])) ? (p['direction'] as Dir) : d);

export const TRANSITIONS: Record<string, Factory> = {
  'preset:transition.fade': () => any(fade()),
  'preset:transition.slide': (p) => any(slide({ direction: dir(p, 'from-right') })),
  'preset:transition.wipe': (p) => any(wipe({ direction: dir(p, 'from-left') })),
  'preset:transition.push-cut': () => any(pushCut()),
  'preset:transition.clock-wipe': (_p, d) => any(clockWipe({ width: d.width, height: d.height })),
  'preset:transition.iris': (_p, d) => any(iris({ width: d.width, height: d.height })),
  'preset:transition.flip': (p) => any(flip({ direction: dir(p, 'from-left') })),
  'preset:transition.zoom-blur': () => any(zoomBlur({})),
  'preset:transition.dreamy-zoom': () => any(dreamyZoom({})),
  'preset:transition.film-burn': () => any(filmBurn({})),
  'preset:transition.linear-blur': () => any(linearBlur({})),
  'preset:transition.book-flip': () => any(bookFlip({})),
  'preset:transition.zoom-in-out': () => any(zoomInOut({})),
  'preset:transition.dissolve': () => any(dissolve({})),
  'preset:transition.ripple': () => any(ripple({})),
  'preset:transition.crosswarp': () => any(crosswarp({})),
  'preset:transition.cross-zoom': () => any(crossZoom({})),
  'preset:transition.swap': () => any(swap({})),
  'preset:transition.blur-slide': (p) => any(blurSlide({ direction: dir(p, 'from-right') } as never)),
  'preset:transition.none': () => any(none({})),
};
