/**
 * Tester, M6.7 (2026-10-17): the size plan swept far wider than the shipped unit sweep. Every
 * plan the browser can make must pass the server's own ladder check, and the snap rule must
 * never enlarge, never exceed 1600 × 2400, and never drop a master below 320 px.
 */
import { describe, expect, it } from "vitest";
import { halvingSteps, planSizes } from "../src/admin/resize";
import { checkLadder, LADDER_STEPS, MASTER_MAX } from "../src/server/upload-validate";

function check(w: number, h: number) {
  const plan = planSizes(1, w, h);
  if (!plan.ok) return plan.reason;
  const ladder = checkLadder(plan.sizes);
  if (!ladder.ok) return `ladder refused ${w}×${h}: ${JSON.stringify(ladder)} ${JSON.stringify(plan.sizes)}`;
  const m = plan.master;
  if (m.width > w || m.height > h) return `enlarged ${w}×${h} -> ${m.width}×${m.height}`;
  if (m.width > MASTER_MAX.width || m.height > MASTER_MAX.height) return `too big ${w}×${h}`;
  return "ok";
}

describe("planSizes, dense sweep", () => {
  it("every width × height in 300–2000 × 1–3000 (every pixel) is accepted by the server or refused up front", () => {
    const bad: string[] = [];
    for (let w = 300; w <= 2000; w++) {
      for (let h = 1; h <= 3000; h++) {
        const r = check(w, h);
        if (r !== "ok" && r !== "too-narrow") bad.push(r);
        if (bad.length > 5) break;
      }
    }
    expect(bad).toEqual([]);
  }, 60_000); // millions of plans: well over the 5 s default when the whole suite runs at once

  it("every width 1–20000 at heights that bind the 2400 limit, and panoramas down to 1 px tall", () => {
    const bad: string[] = [];
    for (let w = 1; w <= 20_000; w++) {
      for (const h of [1, 2, 3, 5, 7, 2399, 2400, 2401, Math.round(w * 1.5), Math.round(w * 1.5) + 1, Math.round(w * 1.5) - 1, Math.round(w * 6), w * 7]) {
        if (h < 1) continue;
        const r = check(w, h);
        if (r !== "ok" && r !== "too-narrow" && r !== "too-many-pixels") bad.push(r);
      }
      if (bad.length > 5) break;
    }
    expect(bad).toEqual([]);
  });

  it("the boundaries of each snap window: s, s+1, s×1.1 and s×1.1+1", () => {
    for (const s of LADDER_STEPS) {
      const edge = Math.floor(s * 1.1);
      expect(planSizes(1, s, s).ok && (planSizes(1, s, s) as { master: { width: number } }).master.width).toBe(s);
      for (const w of [s + 1, edge]) {
        const p = planSizes(1, w, w);
        expect(p.ok && p.master.width, `${w} snaps to ${s}`).toBe(s);
      }
      const p = planSizes(1, edge + 1, edge + 1);
      expect(p.ok && p.master.width, `${edge + 1} kept`).toBe(edge + 1);
    }
  });

  it("319 and 320 px wide", () => {
    expect(planSizes(1, 319, 319)).toEqual({ ok: false, reason: "too-narrow" });
    expect(check(320, 320)).toBe("ok");
    // 320 fitted from the height limit: 400 × 3000 → 320 × 2400.
    const p = planSizes(1, 400, 3000);
    expect(p.ok && p.master).toEqual({ width: 320, height: 2400 });
  });
});

describe("halvingSteps and the canvas sizes the browser allocates", () => {
  // iOS Safari refuses a canvas over 16,777,216 px (4096 × 4096). The decoded <img> is not a canvas,
  // but every halving step is.
  const IOS_CANVAS_AREA = 16_777_216;
  it("no intermediate canvas exceeds the iOS canvas area for any source the plan accepts", () => {
    const over: string[] = [];
    for (const [w, h] of [
      [10_000, 10_000],
      [9_000, 11_000],
      [8_000, 8_000],
      [8064, 6048],
      [6048, 8064],
      [16352, 3628],
      [12_000, 8_000],
    ]) {
      const plan = planSizes(1, w, h);
      if (!plan.ok) continue;
      let cw = w;
      let ch = h;
      for (const step of halvingSteps(w, plan.master.width, h)) {
        const sh = Math.max(1, Math.round((ch * step) / cw));
        if (step * sh > IOS_CANVAS_AREA) over.push(`${w}×${h}: step canvas ${step}×${sh} = ${((step * sh) / 1e6).toFixed(1)} MP`);
        cw = step;
        ch = sh;
      }
    }
    expect(over).toEqual([]);
  });
});
