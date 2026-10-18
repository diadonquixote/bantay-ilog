import Link from "next/link";
import { LevelBadge } from "@/components/LevelBadge";
import { formatLevel, LEVELS } from "@/lib/levels";
import { getDb } from "@/lib/server/db";
import { formatTime } from "@/lib/server/notify";
import { getStationStatus, isStale } from "@/lib/server/status";
import { describeTrend } from "@/lib/server/trend";

export const dynamic = "force-dynamic";

export default async function Home() {
  const db = getDb();
  const stations = (await db.listStations()).filter((s) => s.id !== "demo");
  const statuses = await Promise.all(stations.map((s) => getStationStatus(db, s)));

  return (
    <>
      <section className="card">
        <h1>Bantay Ilog — River Watch</h1>
        <p className="muted" style={{ marginBottom: "1rem" }}>
          Volunteers photograph the river&apos;s staff gauge. The AI reads the water level, checks it against the
          observer&apos;s own reading, tracks how fast the river is rising, and warns subscribed residents on Telegram
          before it reaches the evacuation level.
        </p>
        <div className="row">
          <Link className="button" href="/capture">
            📷 Take a reading
          </Link>
          <Link className="button secondary" href="/dashboard">
            Open dashboard
          </Link>
          <Link className="button secondary" href="/demo">
            Run the demo
          </Link>
        </div>
      </section>

      <div className="grid">
        {statuses.map((s) => (
          <Link
            key={s.station.id}
            href={`/dashboard?station=${s.station.id}`}
            className={`card hero stage-${s.stage ?? "none"}`}
            style={{ textDecoration: "none", color: "inherit" }}
          >
            <div className="row spread">
              <h2 style={{ margin: 0 }}>{s.station.name}</h2>
              <LevelBadge stage={s.stage} />
            </div>
            <div className="muted small">{s.station.river}</div>
            <div className="big-number">
              {s.latest ? (
                formatLevel(s.latest.level)
              ) : (
                <span className="muted" style={{ fontSize: "1.3rem", fontWeight: 600 }}>No reading yet</span>
              )}
            </div>
            {s.latest && (
              <div className="small muted">
                {formatTime(s.latest.takenAt)} · {describeTrend(s.trend)}
              </div>
            )}
            {isStale(s) && (
              <div className="notice warn small">
                Last reading was {s.ageMinutes} min ago — this may not be the river right now.
              </div>
            )}
            {s.pendingHighest &&
            s.pendingHighest.stage !== "normal" &&
            (!s.latest || Date.parse(s.pendingHighest.takenAt) > Date.parse(s.latest.takenAt)) ? (
              <div className="notice error small">
                <strong>Unconfirmed: {formatLevel(s.pendingHighest.level)}</strong> ({LEVELS[s.pendingHighest.stage].label})
                reported {formatTime(s.pendingHighest.takenAt)}, waiting for a team member.
              </div>
            ) : (
              s.pendingConfirmations > 0 && (
                <div className="notice warn small">{s.pendingConfirmations} reading(s) waiting for confirmation</div>
              )
            )}
          </Link>
        ))}
      </div>

      <section className="card">
        <h2>How a reading becomes an alert</h2>
        <ol className="steps small muted" style={{ margin: 0 }}>
          <li>A volunteer photographs the gauge and types the level they see.</li>
          <li>Claude reads the same photo. The two readings must agree, or a second person confirms.</li>
          <li>The trend says how fast the river is rising and when it reaches the next alarm.</li>
          <li>Residents subscribed on Telegram get a bilingual alert with one clear action.</li>
        </ol>
      </section>
    </>
  );
}
