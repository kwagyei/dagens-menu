/**
 * The browser's size plan (plan M6.7 AC: "unit tests for the resize maths"): every plan it makes
 * passes the server's own ladder check, and the refusals happen where ADR-013 says.
 */
import { describe, expect, it } from "vitest";
import { halvingSteps, MAX_FILE_BYTES, planSizes } from "../src/admin/resize";
import { checkLadder } from "../src/server/upload-validate";

describe("planSizes", () => {
  it.each([
    ["12 MP portrait", 3024, 4032, { width: 1600, height: 2133 }, [400, 800, 1200, 1600]],
    ["24 MP landscape", 5712, 4284, { width: 1600, height: 1200 }, [400, 800, 1200, 1600]],
    ["tall phone photo just above a step: cut to 1200", 1242, 2208, { width: 1200, height: 2133 }, [400, 800, 1200]],
    ["well above a step: kept", 1400, 2100, { width: 1400, height: 2100 }, [400, 800, 1200, 1400]],
    ["just above 400: cut to 400", 430, 600, { width: 400, height: 558 }, [400]],
    ["very tall: 2400 high wins", 1000, 6000, { width: 400, height: 2400 }, [400]],
    ["panorama 16352 × 3628", 16352, 3628, { width: 1600, height: 355 }, [400, 800, 1200, 1600]],
    ["small, not enlarged", 800, 600, { width: 800, height: 600 }, [400, 800]],
    ["just wide enough", 320, 240, { width: 320, height: 240 }, [320]],
  ])("%s", (_name, w, h, master, widths) => {
    const plan = planSizes(2_000_000, w, h);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.master).toEqual(master);
    expect(plan.sizes.map((s) => s.width)).toEqual(widths);
    expect(checkLadder(plan.sizes).ok, "the server accepts the ladder").toBe(true);
  });

  it("every plan for widths 320–20000 and many aspects passes the server's ladder check", () => {
    for (let w = 320; w <= 20_000; w += 397) {
      for (const aspect of [0.2, 0.5, 0.75, 1, 1.333, 2, 4.5]) {
        const h = Math.max(1, Math.round(w * aspect));
        const plan = planSizes(1, w, h);
        if (!plan.ok) continue; // too narrow after fitting, or too many pixels
        expect(checkLadder(plan.sizes).ok, `${w} × ${h}`).toBe(true);
      }
    }
  });

  it("refuses a huge file, too many pixels, too narrow, and a size it can't read", () => {
    expect(planSizes(MAX_FILE_BYTES + 1, 4000, 3000)).toEqual({ ok: false, reason: "file-too-large" });
    expect(planSizes(1, 12_000, 9_000)).toEqual({ ok: false, reason: "too-many-pixels" });
    expect(planSizes(1, 319, 400)).toEqual({ ok: false, reason: "too-narrow" });
    expect(planSizes(1, 2000, 30_000)).toEqual({ ok: false, reason: "too-narrow" }); // fits 2400 high at 160 wide
    expect(planSizes(1, 0, 0)).toEqual({ ok: false, reason: "no-size" });
    expect(planSizes(1, Number.NaN, 10)).toEqual({ ok: false, reason: "no-size" });
  });
});

describe("halvingSteps", () => {
  it("halves while the next step is still twice the target", () => {
    expect(halvingSteps(16352, 1600, 3628)).toEqual([8176, 4088]); // the panorama
    expect(halvingSteps(10_000, 1600, 10_000), "a 5000² step would be 25 MP: skipped").toEqual([]);
    expect(halvingSteps(4032, 1600)).toEqual([]);
    expect(halvingSteps(6400, 400)).toEqual([3200, 1600, 800]);
  });
});
