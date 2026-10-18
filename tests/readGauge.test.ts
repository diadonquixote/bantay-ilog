import { describe, expect, it } from "vitest";
import { DEGRADED_CONFIDENCE_CAP, interpretGaugeOutput, parseDataUrl } from "../lib/server/readGauge";
import { MIN_SOLO_CONFIDENCE } from "../lib/server/agree";
import { testStation } from "./helpers";

const out = (over: Partial<Parameters<typeof interpretGaugeOutput>[0]> = {}) => ({
  readable: true,
  level_m: 15.4,
  confidence: 0.95,
  waterline_description: "water just below the 15.5 mark",
  issues: [] as never[],
  ...over,
});

describe("interpretGaugeOutput", () => {
  it("keeps a clean, confident read", () => {
    const r = interpretGaugeOutput(out(), testStation);
    expect(r.level).toBe(15.4);
    expect(r.confidence).toBe(0.95);
    expect(r.issues).toEqual([]);
  });

  it("caps confidence below the solo-accept line when the photo has problems", () => {
    const r = interpretGaugeOutput(out({ issues: ["glare", "waves"] as never }), testStation);
    expect(r.confidence).toBeLessThanOrEqual(DEGRADED_CONFIDENCE_CAP);
    expect(r.confidence).toBeLessThan(MIN_SOLO_CONFIDENCE);
    expect(r.issues).toEqual(["glare", "waves"]);
    expect(r.notes).toMatch(/glare/);
  });

  it("refuses a level that cannot be on this gauge", () => {
    const r = interpretGaugeOutput(out({ level_m: 48 }), testStation);
    expect(r.level).toBeNull();
    expect(r.confidence).toBe(0);
  });

  it("passes an unreadable photo through as unreadable", () => {
    const r = interpretGaugeOutput(out({ readable: false, level_m: null }), testStation);
    expect(r.level).toBeNull();
  });
});

describe("parseDataUrl", () => {
  it("accepts the image types the camera produces", () => {
    expect(parseDataUrl("data:image/jpeg;base64,AAAA").mediaType).toBe("image/jpeg");
  });
  it("rejects anything else", () => {
    expect(() => parseDataUrl("https://example.test/photo.jpg")).toThrow();
    expect(() => parseDataUrl("data:text/html;base64,AAAA")).toThrow();
  });
});
