/**
 * Periodic job: check the PAGASA rainfall advisory, send due reading reminders,
 * retry undelivered messages and apply photo retention.
 *
 *   npm run job:pagasa                      # run once
 *   npm run job:pagasa -- --loop 5          # run every 5 minutes
 *   npm run job:pagasa -- --set orange "Orange rainfall warning over Metro Manila"   # drills / manual entry
 *
 * A deployment that cannot run a second process can POST to /api/cron instead.
 */
import { existsSync } from "node:fs";
import { getDb } from "../../lib/server/db";
import { getNotifier } from "../../lib/server/notify";
import { tick } from "../../lib/server/tick";
import { RainfallWarning } from "../../lib/schemas";

for (const f of [".env.local", ".env"]) if (existsSync(f)) process.loadEnvFile(f);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export async function runOnce(override?: { warning: RainfallWarning; text: string }) {
  const db = getDb();
  const notifier = getNotifier(db);
  await tick(db, notifier, {
    override,
    log: (msg) => console.log(`[pagasa-check ${new Date().toISOString()}] ${msg}`),
  });
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
