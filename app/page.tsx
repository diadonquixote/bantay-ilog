import Link from "next/link";
import { LevelBadge } from "@/components/LevelBadge";
import { formatLevel, LEVELS } from "@/lib/levels";
import { getDb } from "@/lib/server/db";
import { formatTime } from "@/lib/server/notify";
import { getStationStatus } from "@/lib/server/status";
import { describeTrend } from "@/lib/server/trend";

export const dynamic = "force-dynamic";

export default async function Home() {
  const db = getDb();
  const stations = await db.listStations();
  const statuses = await Promise.all(stations.map((s) => getStationStatus(db, s)));

  return (
    <>
      <section className="card">
        <h1>Bantay Ilog — River Watch</h1>
        <p>
          Volunteers photograph the river&apos;s staff gauge. The AI reads the water level, checks it against the
          observer&apos;s own reading, tracks how fast the river is rising, and warns subscribed residents on Telegram
          before it reaches the evacuation level.
        </p>
        <div className="row">
          <Link className="button" href="/capture">
            📷 Take a reading
          </Link>
          <Link className="button secondary" href="/dashboard">
            Dashboard
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
            className="card"
            style={{ textDecoration: "none", color: "inherit" }}
          >
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h2 style={{ margin: 0 }}>{s.station.name}</h2>
              <LevelBadge stage={s.stage} />
            </div>
            <div className="muted small">{s.station.river}</div>
            <div className="big-number" style={{ marginTop: "0.5rem" }}>
              {s.latest ? formatLevel(s.latest.level) : <span className="muted" style={{ fontSize: "1.3rem" }}>No reading yet</span>}
            </div>
            {s.latest && (
              <div className="small muted">
                as of {formatTime(s.latest.takenAt)} · {describeTrend(s.trend)}
              </div>
            )}
            {s.pendingHighest && s.pendingHighest.stage !== "normal" &&
            (!s.latest || Date.parse(s.pendingHighest.takenAt) > Date.parse(s.latest.takenAt)) ? (
              <div className="notice error small">
                <strong>Unconfirmed: {formatLevel(s.pendingHighest.level)}</strong> ({LEVELS[s.pendingHighest.stage].label}) reported{" "}
                {formatTime(s.pendingHighest.takenAt)}, waiting for a team member to confirm.
              </div>
            ) : (
              s.pendingConfirmations > 0 && (
                <div className="notice warn small">{s.pendingConfirmations} reading(s) waiting for confirmation</div>
              )
            )}
          </Link>
        ))}
      </div>

    </>
  );
}
