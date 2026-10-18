/** Edge cases in the smoke check's reading of the gallery HTML. */
import { describe, expect, it } from "vitest";
import { galleryProblems } from "../scripts/smoke.mjs";

const page = (img: string, cls = "gallery-magazine") => `<ul class="${cls}"><li>${img}</li></ul>`;

describe("galleryProblems", () => {
  it("still finds the first photo when alt text contains >", () => {
    const r = galleryProblems("/gallery/", page(`<img alt="a > b" src="/media/x.webp">`));
    expect(r.photo).toBe("/media/x.webp");
  });
  it("reads single-quoted attributes", () => {
    const r = galleryProblems("/gallery/", page(`<img src='/media/x.webp' alt='Fin'>`));
    expect(r.problems).toEqual([]);
    expect(r.photo).toBe("/media/x.webp");
  });
  it("finds the list when the ul has another class", () => {
    const r = galleryProblems("/gallery/", page(`<img src="/media/x.webp" alt="Fin">`, "gallery-magazine extra"));
    expect(r.problems).toEqual([]);
  });
});
