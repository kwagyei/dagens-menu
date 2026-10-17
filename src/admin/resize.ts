/**
 * The sizes a photo becomes in the browser before upload (plan M6.7; ADR-012 §2, ADR-013).
 * Pure arithmetic, shared by the upload script and its unit tests; the server checks the
 * result with the same rules (src/server/upload-validate.ts).
 */
import { LADDER_STEPS, MASTER_MAX, MASTER_MIN_WIDTH } from "../server/upload-validate";

/** A file this large is refused before it is opened: no phone photo comes close. */
export const MAX_FILE_BYTES = 40_000_000;
/** Decoding more pixels than this risks the browser's memory, especially on iOS. */
export const MAX_PIXELS = 100_000_000;
/**
 * A master just above a ladder step is cut to that step: 1242 px would otherwise make both a
 * 1200 and a 1242 px size, nearly the same photo twice, which roughly doubles the upload and
 * pushed a normal phone photo over the 1 MB cap in the held-out run (M6.7 error analysis).
 */
export const SNAP_WITHIN = 0.1;

export type SizePlan =
  | {
      ok: true;
      /** The widest size: the original scaled to fit 1600 × 2400, never enlarged. */
      master: { width: number; height: number };
      /** Every size to make, smallest first; the last is the master. */
      sizes: Array<{ width: number; height: number }>;
    }
  | { ok: false; reason: "file-too-large" | "too-many-pixels" | "too-narrow" | "no-size" };

export function planSizes(fileBytes: number, width: number, height: number): SizePlan {
  if (fileBytes > MAX_FILE_BYTES) return { ok: false, reason: "file-too-large" };
  if (!(width >= 1 && height >= 1) || !Number.isFinite(width) || !Number.isFinite(height)) return { ok: false, reason: "no-size" };
  if (width * height > MAX_PIXELS) return { ok: false, reason: "too-many-pixels" };
  let scale = Math.min(1, MASTER_MAX.width / width, MASTER_MAX.height / height);
  const fitted = Math.round(width * scale);
  const step = [...LADDER_STEPS].reverse().find((s) => s < fitted && fitted <= s * (1 + SNAP_WITHIN));
  if (step) scale = step / width;
  const master = { width: step ?? fitted, height: Math.max(1, Math.round(height * scale)) };
  if (master.width < MASTER_MIN_WIDTH) return { ok: false, reason: "too-narrow" };
  const widths = [...LADDER_STEPS.filter((w) => w < master.width), master.width];
  const sizes = widths.map((w) => ({ width: w, height: Math.max(1, Math.round((master.height * w) / master.width)) }));
  return { ok: true, master, sizes };
}

/**
 * Intermediate widths for a large reduction: halve while the next step is still at least twice
 * the target, so each draw averages at most about 2 × 2 pixels into one. One big jump in a
 * canvas skips pixels and looks jagged (ADR-013, "halving steps").
 */
export function halvingSteps(fromWidth: number, toWidth: number): number[] {
  const steps: number[] = [];
  for (let w = Math.floor(fromWidth / 2); w >= toWidth * 2; w = Math.floor(w / 2)) steps.push(w);
  return steps;
}
