import { describe, expect, it } from "vitest";
import { analyzePixels } from "../lib/client/colorCheck";

function image(w: number, h: number, px: (x: number, y: number) => [number, number, number]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = px(x, y);
      data.set([r, g, b, 255], (y * w + x) * 4);
    }
  return data;
}

// Red/white stripes: a crude sharp gauge.
const gauge = (x: number, y: number): [number, number, number] =>
  x < 20 ? [130, 130, 130] : Math.floor(y / 6) % 2 ? [220, 30, 30] : [245, 245, 240];

describe("analyzePixels", () => {
  it("passes a sharp, well-lit gauge", () => {
    const r = analyzePixels(image(60, 120, gauge), 60, 120);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it("reports only darkness for a dark photo, not the blur/contrast it causes", () => {
    const r = analyzePixels(image(60, 120, () => [10, 10, 12]), 60, 120);
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toEqual(["dark"]);
  });

  it("flags a flat photo with no gauge colours", () => {
    const r = analyzePixels(image(60, 120, () => [120, 130, 125]), 60, 120);
    expect(r.issues.map((i) => i.code)).toContain("no_gauge_colors");
  });
});
