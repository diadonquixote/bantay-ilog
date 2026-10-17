import type { Advisory, RainfallWarning } from "../schemas";
import { RainfallWarning as RainfallWarningSchema } from "../schemas";
import { type Db, newId, nowIso } from "./db";

const RANK: Record<RainfallWarning, number> = { unknown: -1, none: 0, yellow: 1, orange: 2, red: 3 };

export function warningRank(w: RainfallWarning): number {
  return RANK[w];
}

/**
 * Extract a rainfall warning from whatever the advisory URL returns:
 * JSON {"warning": "...", "text": "..."}, or an HTML/text bulletin that is
 * scanned for the highest RED/ORANGE/YELLOW rainfall warning it mentions.
 */
export function parseAdvisory(body: string): { warning: RainfallWarning; text: string } {
  try {
    const json = JSON.parse(body) as { warning?: string; text?: string };
    const w = RainfallWarningSchema.safeParse(String(json.warning ?? "").toLowerCase());
    if (w.success) return { warning: w.data, text: String(json.text ?? "") };
  } catch {
    // not JSON — fall through to text scan
  }

  const text = body
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  for (const color of ["red", "orange", "yellow"] as const) {
    const re = new RegExp(`\\b${color}\\s+(rainfall\\s+)?warning\\b`, "i");
    const m = re.exec(text);
    if (m) {
      const start = Math.max(0, m.index - 200);
      return { warning: color, text: text.slice(start, m.index + 400) };
    }
  }
  return { warning: "none", text: text.slice(0, 400) };
}

export async function fetchAdvisory(url: string): Promise<{ warning: RainfallWarning; text: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { "user-agent": "bantay-ilog/0.1" } });
  if (!res.ok) throw new Error(`PAGASA advisory HTTP ${res.status}`);
  return parseAdvisory(await res.text());
}

export async function recordAdvisory(
  db: Db,
  a: { warning: RainfallWarning; text: string },
  source: string,
): Promise<{ advisory: Advisory; previous: Advisory | null; escalated: boolean }> {
  const previous = await db.latestAdvisory();
  const advisory: Advisory = { id: newId(), warning: a.warning, text: a.text, source, fetchedAt: nowIso() };
  await db.insertAdvisory(advisory);
  const escalated = warningRank(a.warning) > Math.max(0, previous ? warningRank(previous.warning) : 0);
  return { advisory, previous, escalated };
}
