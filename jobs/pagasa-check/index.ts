/**
 * Periodic job: check the PAGASA rainfall advisory and send due reading reminders.
 *
 *   npm run job:pagasa                      # run once
 *   npm run job:pagasa -- --loop 5          # run every 5 minutes
 *   npm run job:pagasa -- --set orange "Orange rainfall warning over Metro Manila"   # drills / manual entry
 *
 * Without PAGASA_ADVISORY_URL the advisory step is skipped (reminders still run).
 */
import { existsSync } from "node:fs";
import { runAlertAgent } from "../../lib/server/alertAgent";
import { getDb } from "../../lib/server/db";
import { getNotifier, notifyTeam } from "../../lib/server/notify";
import { fetchAdvisory, recordAdvisory } from "../../lib/server/pagasa";
import { processReminders } from "../../lib/server/reminders";
import { RainfallWarning } from "../../lib/schemas";

for (const f of [".env.local", ".env"]) if (existsSync(f)) process.loadEnvFile(f);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export async function runOnce(override?: { warning: RainfallWarning; text: string }) {
  const db = getDb();
  const notifier = getNotifier(db);
  const log = (msg: string) => console.log(`[pagasa-check ${new Date().toISOString()}] ${msg}`);

  const url = process.env.PAGASA_ADVISORY_URL;
  let fetched: { warning: RainfallWarning; text: string } | null = override ?? null;
  if (!fetched && url) {
    try {
      fetched = await fetchAdvisory(url);
    } catch (e) {
      log(`advisory fetch failed: ${(e as Error).message}`);
    }
  } else if (!fetched) {
    log("PAGASA_ADVISORY_URL not set; skipping advisory fetch");
  }

  if (fetched) {
    const { advisory, previous, escalated } = await recordAdvisory(db, fetched, override ? "manual" : url!);
    log(`advisory: ${advisory.warning} (was ${previous?.warning ?? "none on record"})`);
    if (escalated && (advisory.warning === "orange" || advisory.warning === "red")) {
      for (const station of await db.listStations()) {
        if (station.id === "demo") continue;
        await notifyTeam(
          notifier,
          station,
          `🌧 PAGASA ${advisory.warning.toUpperCase()} rainfall warning. Dalasan ang pagkuha ng sukat sa ${station.name}.\n` +
            `Take gauge readings more often at ${station.name}.\n${advisory.text.slice(0, 500)}`,
        );
        const outcome = await runAlertAgent({ db, notifier, station, readingId: null, now: new Date(), sent: [] });
        log(`${station.id}: alert agent ${outcome.mode} — ${outcome.summary}`);
      }
    }
  }

  const r = await processReminders(db, notifier);
  log(`reminders sent: ${r.explicit} scheduled, ${r.cadence} cadence`);
}

async function main() {
  const i = process.argv.indexOf("--set");
  const override =
    i >= 0
      ? {
          warning: RainfallWarning.parse(String(process.argv[i + 1]).toLowerCase()),
          text: process.argv[i + 2] ?? `${process.argv[i + 1]} rainfall warning (manual entry)`,
        }
      : undefined;

  await runOnce(override);
  const loop = Number(arg("--loop"));
  if (loop > 0) {
    console.log(`Looping every ${loop} min. Ctrl+C to stop.`);
    setInterval(() => runOnce().catch((e) => console.error(e)), loop * 60_000);
  }
}

if (process.argv[1]?.replace(/\\/g, "/").includes("jobs/pagasa-check")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
