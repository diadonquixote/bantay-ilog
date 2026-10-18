import { afterEach, describe, expect, it } from "vitest";
import { adminOpen, isAdmin, safeEqual } from "../lib/server/auth";
import { rateLimit, resetRateLimits } from "../lib/server/rateLimit";
import { maskName, publicReading, publicStation } from "../lib/server/redact";
import { FrameRequest, ManualReadingRequest } from "../lib/schemas";
import { reading, testStation } from "./helpers";

const req = (headers: Record<string, string> = {}) => new Request("https://example.test/api", { headers });

const withEnv = (vars: Record<string, string | undefined>, fn: () => void) => {
  const old: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    old[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

afterEach(() => resetRateLimits());

describe("admin auth", () => {
  it("stays open in development so the demo needs no setup", () => {
    withEnv({ ADMIN_TOKEN: undefined, NODE_ENV: "development" }, () => {
      expect(isAdmin(req())).toBe(true);
      expect(adminOpen()).toBe(true);
    });
  });

  it("fails closed in production when no token is configured", () => {
    withEnv({ ADMIN_TOKEN: undefined, NODE_ENV: "production" }, () => {
      expect(isAdmin(req())).toBe(false);
      expect(adminOpen()).toBe(false);
    });
  });

  it("checks the token when one is set", () => {
    withEnv({ ADMIN_TOKEN: "s3cret-token", NODE_ENV: "production" }, () => {
      expect(isAdmin(req())).toBe(false);
      expect(isAdmin(req({ "x-admin-token": "wrong" }))).toBe(false);
      expect(isAdmin(req({ "x-admin-token": "s3cret-token" }))).toBe(true);
    });
  });

  it("compares different-length secrets without throwing", () => {
    expect(safeEqual("short", "a much longer secret")).toBe(false);
    expect(safeEqual("same", "same")).toBe(true);
  });
});

describe("rate limit", () => {
  it("allows a burst then asks the caller to wait", () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) expect(rateLimit("k", { limit: 3, windowSec: 60 }, now)).toBeNull();
    const wait = rateLimit("k", { limit: 3, windowSec: 60 }, now);
    expect(wait).toBeGreaterThan(0);
    // Tokens refill over the window.
    expect(rateLimit("k", { limit: 3, windowSec: 60 }, now + 30_000)).toBeNull();
  });

  it("counts each caller separately", () => {
    const now = Date.now();
    expect(rateLimit("a", { limit: 1, windowSec: 60 }, now)).toBeNull();
    expect(rateLimit("b", { limit: 1, windowSec: 60 }, now)).toBeNull();
    expect(rateLimit("a", { limit: 1, windowSec: 60 }, now)).toBeGreaterThan(0);
  });
});

describe("redaction", () => {
  it("never exposes observer team chat ids", () => {
    expect(publicStation({ ...testStation, teamChatIds: ["123456789"] }).teamChatIds).toEqual([]);
  });

  it("hides volunteer names and photos from the public", () => {
    const r = { ...reading(15.2), observerName: "Kagawad Reyes", photoPath: "sto-nino/2026-10-18/x.jpg", photoHash: "abc" };
    const pub = publicReading(r);
    expect(pub.observerName).toBe("Kagawad R.");
    expect(pub.photoPath).toBeNull();
    expect(pub.photoHash).toBeNull();
    expect(pub.observerKey).toBeNull();
    // The measurement itself stays public: it is what the warning rests on.
    expect(pub.level).toBe(15.2);
  });

  it("does not leak a telegram id through a name", () => {
    expect(maskName("tg:987654321")).toBe("observer");
  });
});

describe("request validation", () => {
  const base = { stationId: "sto-nino", image: "data:image/jpeg;base64,AAAA" };

  it("rejects a reading timestamped in the future", () => {
    const takenAt = new Date(Date.now() + 60 * 60_000).toISOString();
    expect(FrameRequest.safeParse({ ...base, takenAt }).success).toBe(false);
  });

  it("rejects a reading older than a day", () => {
    const takenAt = new Date(Date.now() - 30 * 3_600_000).toISOString();
    expect(FrameRequest.safeParse({ ...base, takenAt }).success).toBe(false);
  });

  it("accepts a reading from a few minutes ago", () => {
    const takenAt = new Date(Date.now() - 3 * 60_000).toISOString();
    expect(FrameRequest.safeParse({ ...base, takenAt }).success).toBe(true);
  });

  it("applies the same clock check to typed readings", () => {
    const takenAt = new Date(Date.now() + 3 * 3_600_000).toISOString();
    expect(
      ManualReadingRequest.safeParse({ stationId: "sto-nino", level: 15.2, observerName: "Juan", takenAt }).success,
    ).toBe(false);
  });
});
