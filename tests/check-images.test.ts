/** The CI photo check's parser (scripts/check-images.mjs, plan M6.9). */
import { describe, expect, it } from "vitest";
import { checkImgTags } from "../scripts/check-images.mjs";

describe("checkImgTags", () => {
  it("accepts a sized photo with srcset and alt, and a decorative hero with alt=\"\"", () => {
    const html = `<img src="/a-800.webp" srcset="/a-400.webp 400w, /a-800.webp 800w" sizes="100vw" width="800" height="600" alt="Köttbullar">
      <img class="hero-ljus__img" src="/h.webp" srcset="/h-400.webp 400w" width="400" height="300" alt="">
      <img class="hero-dag__img" src="/d.webp" srcset="/d-400.webp 400w" width="400" height="300" alt>`;
    const r = checkImgTags(html);
    expect(r.problems).toEqual([]);
    expect([...r.urls]).toEqual(["/a-400.webp", "/a-800.webp", "/h-400.webp", "/d-400.webp"]);
  });
  it("flags a missing width, height, srcset or alt, and an empty alt off the hero", () => {
    expect(checkImgTags(`<img src="/x.jpg" alt="x">`).problems).toEqual(['<img src="/x.jpg"> has no width', '<img src="/x.jpg"> has no height', '<img src="/x.jpg"> has no srcset']);
    expect(checkImgTags(`<img src="/x" srcset="/x 1w" width="1" height="1">`).problems).toEqual(['<img src="/x"> has no alt']);
    expect(checkImgTags(`<img src="/x" srcset="/x 1w" width="1" height="1" alt="">`).problems[0]).toContain("empty alt");
  });
});
