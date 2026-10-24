/**
 * Close flow decisions (FR-002, ARCHITECTURE.md §5 step 5). Pure module: no `electron` import (unit-tested on Linux).
 * The Editor asks first (unsaved prompt, running-render prompt); this is the Shell's own guard for the case the Editor could
 * not ask (renderer hung or crashed, a render that started meanwhile): R-002 answers 409 EM-8304 while a render runs and
 * `force` is not set. The Shell then shows a native dialog and retries with force, or keeps the Service and reopens the Editor.
 */

export type ShutdownAnswer = { kind: 'accepted' } | { kind: 'render-running'; rendering: number } | { kind: 'failed'; status: number };

/** Classifies the R-002 response. Anything but 202 / 409 EM-8304 is treated as failed (the Shell then stops the process itself). */
export function parseShutdownResponse(status: number, bodyText: string): ShutdownAnswer {
  if (status === 202 || status === 200) return { kind: 'accepted' };
  if (status === 409) {
    try {
      const body = JSON.parse(bodyText) as { error?: { code?: string; details?: { rendering?: number } } };
      if (body.error?.code === 'EM-8304') return { kind: 'render-running', rendering: Number(body.error.details?.rendering ?? 1) };
    } catch { /* not an envelope */ }
  }
  return { kind: 'failed', status };
}

/** Native dialog copy (EM-8304, ERROR_CATALOGUE.md). Button order: index 0 is the safe default. */
export const RENDER_RUNNING_DIALOG = {
  title: 'A render is still running',
  message: 'A render is still running / Render masih berjalan',
  detail: 'Closing now will cancel the render. / Menutup sekarang akan membatalkan render.\n\nEM-8304',
  buttons: ['Keep rendering / Lanjutkan render', 'Cancel render and close / Batalkan render dan tutup'],
  defaultId: 0,
  cancelId: 0,
} as const;

export type CloseChoice = 'keep' | 'cancel-and-close';
export const choiceFromButton = (response: number): CloseChoice => (response === 1 ? 'cancel-and-close' : 'keep');
