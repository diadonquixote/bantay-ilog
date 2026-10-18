import Link from "next/link";
import { AutoRefresh } from "@/components/AutoRefresh";
import { StationStatusPanel } from "@/components/StationStatusPanel";
import { getDb } from "@/lib/server/db";
import { getStationStatus, STALE_AFTER_MIN } from "@/lib/server/status";

export const dynamic = "force-dynamic";

export default async function Home() {
  const db = getDb();
  // The demo station lives on /demo; residents only see real gauges.
  const stations = (await db.listStations()).filter((s) => s.id !== "demo");
  const statuses = await Promise.all(stations.map((s) => getStationStatus(db, s)));
  const bot = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;

  return (
    <>
      <AutoRefresh seconds={60} />
      <div className="page-head">
        <div>
          <h1>River status</h1>
          <p className="muted">Lebel ng ilog ngayon · confirmed readings from your barangay&apos;s volunteer observers</p>
        </div>
      </div>

      {statuses.length === 0 && (
        <div className="card">
          <p>No gauge stations are set up yet.</p>
          <Link href="/setup" className="button">
            Add a station
          </Link>
        </div>
      )}

      <div className="stations">
        {statuses.map((s) => (
          <StationStatusPanel
            key={s.station.id}
            station={s.station}
            latest={s.latest}
            stage={s.stage}
            trend={s.trend}
            pending={s.pendingHighest}
            ageMinutes={s.ageMinutes}
            staleAfterMin={STALE_AFTER_MIN}
          >
            <div className="row" style={{ marginTop: "1rem" }}>
              <Link className="button secondary" href={`/dashboard?station=${s.station.id}`}>
                History &amp; details
              </Link>
              {bot && (
                <a className="button secondary" href={`https://t.me/${bot}?start=${s.station.id}`}>
                  Get alerts on Telegram
                </a>
              )}
            </div>
          </StationStatusPanel>
        ))}
      </div>

      <section className="card" style={{ marginTop: "0.5rem" }}>
        <h2>How readings become alerts</h2>
        <ol className="how">
          <li>
            <strong>A volunteer photographs the gauge</strong> and types the level they see.
          </li>
          <li>
            <strong>The photo is read by AI and checked against the volunteer.</strong> If they differ by more than the station&apos;s allowed margin (10 cm by default), a
            second team member confirms it first.
          </li>
          <li>
            <strong>The trend shows how fast the river is rising</strong> and when it will reach the next alarm.
          </li>
          <li>
            <strong>Residents get a Telegram alert</strong> in Tagalog and English when the river reaches the 1st, 2nd or 3rd
            alarm, or is rising fast toward it.
          </li>
        </ol>
        <div className="row">
          <Link href="/capture" className="button">
            I&apos;m a volunteer — take a reading
          </Link>
          {!bot && (
            <span className="small muted">
              Residents: send <code>/subscribe &lt;station&gt;</code> to the barangay&apos;s Telegram bot.
            </span>
          )}
        </div>
      </section>
    </>
  );
}
