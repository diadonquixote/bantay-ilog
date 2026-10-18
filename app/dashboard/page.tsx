"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, useAdminToken } from "@/components/api";
import { LevelBadge } from "@/components/LevelBadge";
import { LevelChart } from "@/components/LevelChart";
import { formatLevel, LEVELS } from "@/lib/levels";
import type { Advisory, Alert, LevelKey, OutboxMessage, Reading, Station } from "@/lib/schemas";

interface Trend {
  ratePerHour: number | null;
  direction: string;
  samples: number;
  eta: { key: LevelKey; value: number; minutes: number } | null;
}

interface DashboardData {
  station: Station;
  stations: Station[];
  system: {
    ai: string;
    model: string | null;
    db: string;
    telegram: string;
    adminTokenRequired: boolean;
    adminOpen: boolean;
    isAdmin: boolean;
    lastTick: string | null;
  };
  status: {
    latest: Reading | null;
    stage: LevelKey | null;
    ageMinutes: number | null;
    trend: Trend;
    pendingConfirmations: number;
    pendingHighest: { readingId: string; level: number; stage: LevelKey; takenAt: string } | null;
  };
  readings: Reading[];
  alerts: Alert[];
  advisory: Advisory | null;
  subscriberCount: number;
  outbox: OutboxMessage[] | null;
}

const fmt = (iso: string) =>
  new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));

const ago = (min: number | null) =>
  min == null ? "" : min < 1 ? "just now" : min < 60 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;

const STALE_MIN = 90;

function initialStation(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("station");
}

export default function Dashboard() {
  const [stationId, setStationId] = useState<string | null>(null);
  const [hours, setHours] = useState(24);
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [token, setToken] = useAdminToken();
  const [sound, setSound] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    setStationId(initialStation());
    try {
      setName(localStorage.getItem("bantay-name") ?? "");
    } catch {}
  }, []);

  const load = useCallback(async () => {
    try {
      const qs = stationId ? `?stationId=${encodeURIComponent(stationId)}&hours=${hours}` : `?hours=${hours}`;
      const first = await api<DashboardData & { stations: Station[] }>(`/api/readings${qs}`);
      // No station in the URL: land on the first real station.
      if (!stationId) {
        const pick = first.stations.find((s) => s.id !== "demo") ?? first.stations[0];
        if (pick) {
          setStationId(pick.id);
          return;
        }
      }
      setData(first);
      setUpdatedAt(new Date());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [stationId, hours, token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [load]);

  const stage = data?.status.stage ?? null;
  useEffect(() => {
    if (sound && stage === "critical") audio.current?.play().catch(() => {});
  }, [sound, stage, data?.status.latest?.id]);

  const selectStation = (id: string) => {
    setStationId(id);
    window.history.replaceState(null, "", `?station=${id}`);
  };

  const confirm = async (r: Reading, action: "accept" | "reject", level?: number) => {
    if (!name.trim()) {
      setError("Enter your name before confirming readings.");
      return;
    }
    setBusy(r.id);
    try {
      await api("/api/confirm", { method: "POST", json: { action, readingId: r.id, level, confirmedBy: name.trim() } });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!data) {
    return (
      <div className="card">
        {error ? (
          <>
            <div className="notice error">{error}</div>
            <button className="secondary" onClick={load}>
              Try again
            </button>
          </>
        ) : (
          <p className="muted">
            <span className="spinner" aria-hidden /> Loading…
          </p>
        )}
      </div>
    );
  }

  const { station, status, system } = data;
  const trend = status.trend;
  const pending = data.readings.filter((r) => r.status === "needs_confirmation");
  const ph = status.pendingHighest;
  const unconfirmedHigh =
    ph && ph.stage !== "normal" && (!status.latest || Date.parse(ph.takenAt) > Date.parse(status.latest.takenAt)) ? ph : null;
  const stale = status.ageMinutes != null && status.ageMinutes > STALE_MIN;
  const needsToken = system.adminTokenRequired && !system.isAdmin;

  return (
    <>
      <audio ref={audio} src="/audio/alarm.wav" preload="auto" />

      <div className="row spread" style={{ marginBottom: "0.75rem" }}>
        <div className="row">
          <select value={station.id} onChange={(e) => selectStation(e.target.value)} style={{ width: "auto" }} aria-label="Station">
            {data.stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} — {s.river}
              </option>
            ))}
          </select>
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))} style={{ width: "auto" }} aria-label="Time range">
            {[6, 24, 72, 168].map((h) => (
              <option key={h} value={h}>
                Last {h < 48 ? `${h} h` : `${h / 24} days`}
              </option>
            ))}
          </select>
        </div>
        <label className="row small" style={{ margin: 0, fontWeight: 600 }}>
          <input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} style={{ width: "auto" }} />
          Sound alarm at critical
        </label>
      </div>

      {error && <div className="notice error">{error}</div>}

      {needsToken && (
        <div className="card">
          <h2>Team sign-in</h2>
          <p className="small muted" style={{ marginTop: 0 }}>
            Volunteer names and gauge photos are only shown to the observer team, and confirming a reading needs the
            token too.
          </p>
          <label htmlFor="token">Admin token</label>
          <input
            id="token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="ADMIN_TOKEN"
            autoComplete="current-password"
          />
          <button style={{ marginTop: "0.6rem" }} onClick={load}>
            Unlock
          </button>
        </div>
      )}

      {unconfirmedHigh && (
        <div className="notice error loud">
          <strong>
            Unconfirmed reading of {formatLevel(unconfirmedHigh.level)} ({LEVELS[unconfirmedHigh.stage].label}) since{" "}
            {fmt(unconfirmedHigh.takenAt)}.
          </strong>{" "}
          Residents get the confirmed alert once a team member confirms it below.
        </div>
      )}
      {stale && (
        <div className="notice warn">
          <strong>No fresh reading for {ago(status.ageMinutes)}.</strong> The alert agent will not warn residents from a
          stale number — ask the team for a new photo.
        </div>
      )}
      {system.adminOpen && (
        <div className="notice warn small">
          <strong>ADMIN_TOKEN is not set.</strong> Anyone who can open this page can confirm readings. Set it before
          putting the app on the internet.
        </div>
      )}
      {station.teamChatIds.length === 0 && system.isAdmin && (
        <div className="notice warn">
          No observer team is set up for this station, so nobody is notified when a reading needs confirmation.{" "}
          <a href="/setup">Add team chat IDs in Setup.</a>
        </div>
      )}

      {pending.length > 0 && (
        <section className="card" style={{ borderColor: "var(--alarm)" }}>
          <h2>Waiting for confirmation ({pending.length})</h2>
          <p className="small muted" style={{ marginTop: 0 }}>
            A reading is confirmed by someone other than the person who sent it.
          </p>
          <label htmlFor="who">Your name</label>
          <input
            id="who"
            placeholder="Required to confirm"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              try {
                localStorage.setItem("bantay-name", e.target.value);
              } catch {}
            }}
            style={{ maxWidth: 320 }}
          />
          {pending.map((r) => (
            <PendingReading key={r.id} r={r} busy={busy === r.id} onConfirm={confirm} canSeePhoto={system.isAdmin} />
          ))}
        </section>
      )}

      <div className="grid">
        <section className={`card hero stage-${stage ?? "none"}`}>
          <div className="muted small">
            {station.name} · {station.river}
          </div>
          <div className="big-number">
            {status.latest ? (
              formatLevel(status.latest.level)
            ) : (
              <span className="muted" style={{ fontSize: "1.4rem", fontWeight: 600 }}>No reading yet</span>
            )}
          </div>
          {stage && (
            <div className="row">
              <LevelBadge stage={stage} /> <LevelBadge stage={stage} tl />
            </div>
          )}
          {stage && <p style={{ margin: "0.6rem 0 0" }}>{LEVELS[stage].action}</p>}
          <p className="small muted" style={{ margin: "0.35rem 0 0" }}>
            {status.latest
              ? `Confirmed ${fmt(status.latest.takenAt)} · ${ago(status.ageMinutes)}`
              : "Waiting for the first confirmed reading."}
          </p>
        </section>

        <section className="card">
          <h2>Trend</h2>
          {trend.ratePerHour == null ? (
            <p className="muted">Need at least two confirmed readings in the last 2 hours.</p>
          ) : (
            <>
              <div className="big-number" style={{ fontSize: "1.9rem" }}>
                {trend.direction === "rising" ? "▲" : trend.direction === "falling" ? "▼" : "▬"}{" "}
                {trend.ratePerHour >= 0 ? "+" : ""}
                {trend.ratePerHour.toFixed(2)} m/h
              </div>
              <p className="small muted" style={{ margin: 0 }}>
                {trend.direction} over {trend.samples} readings (last 2 h)
              </p>
              {trend.eta && (
                <div className="notice warn small">
                  Projected to reach <strong>{LEVELS[trend.eta.key].label}</strong> ({trend.eta.value} m) in about{" "}
                  <strong>{trend.eta.minutes} min</strong> if the current rate holds.
                </div>
              )}
            </>
          )}
        </section>

        <section className="card">
          <h2>PAGASA &amp; reach</h2>
          <p className="small" style={{ margin: 0 }}>
            Rainfall warning: <strong>{data.advisory ? data.advisory.warning.toUpperCase() : "none on record"}</strong>
            {data.advisory && <span className="muted"> · {fmt(data.advisory.fetchedAt)}</span>}
          </p>
          <p className="small" style={{ margin: "0.3rem 0 0" }}>
            Subscribers: <strong>{data.subscriberCount}</strong> · Observer team:{" "}
            <strong>{system.isAdmin ? station.teamChatIds.length : "—"}</strong>
          </p>
          <p className="small muted" style={{ margin: "0.3rem 0 0" }}>
            Background job: {system.lastTick ? `last ran ${fmt(system.lastTick)}` : "has not run yet"}
          </p>
          {updatedAt && (
            <p className="small muted" style={{ margin: "0.3rem 0 0" }}>
              Page refreshes every 20 s · updated {updatedAt.toLocaleTimeString("en-PH", { timeZone: "Asia/Manila" })}
            </p>
          )}
        </section>
      </div>

      <section className="card">
        <h2>Water level</h2>
        <LevelChart station={station} readings={data.readings} hours={hours} />
      </section>

      <section className="card">
        <h2>Alerts sent</h2>
        {data.alerts.length === 0 ? (
          <p className="muted">No alerts in this period.</p>
        ) : (
          data.alerts.map((a) => (
            <div key={a.id} className={`notice stage-${a.level}`} style={{ borderLeftColor: LEVELS[a.level].color }}>
              <div className="row small muted">
                <LevelBadge stage={a.level} /> <span className="pill">{a.kind}</span> {fmt(a.createdAt)} ·{" "}
                {a.origin === "agent" ? "agent decided" : "rule"} · {a.recipients} recipient(s)
              </div>
              <div style={{ whiteSpace: "pre-wrap", marginTop: "0.35rem" }}>{a.message}</div>
            </div>
          ))
        )}
      </section>

      <section className="card">
        <h2>Readings</h2>
        <div className="table-wrap">
          <table className="stack-on-phone">
            <thead>
              <tr>
                <th>Time</th>
                <th>Level</th>
                <th>AI</th>
                <th>Observer</th>
                <th>Status</th>
                {system.isAdmin && <th>Photo</th>}
              </tr>
            </thead>
            <tbody>
              {data.readings.map((r) => (
                <tr key={r.id}>
                  <td className="num" data-label="Time">
                    {fmt(r.takenAt)}
                  </td>
                  <td className="num" data-label="Level">
                    <strong>{formatLevel(r.level)}</strong>
                  </td>
                  <td className="num" data-label="AI">
                    {formatLevel(r.aiLevel)}
                    {r.aiConfidence != null && <span className="muted small"> ({r.aiConfidence.toFixed(2)})</span>}
                  </td>
                  <td className="num" data-label="Observer">
                    {formatLevel(r.observerLevel)}
                    {r.observerName && <div className="muted small">{r.observerName}</div>}
                  </td>
                  <td data-label="Status">
                    <span className={`pill ${r.status}`}>{r.status.replace("_", " ")}</span>
                    <div className="muted small">{r.statusReason}</div>
                  </td>
                  {system.isAdmin && (
                    <td data-label="Photo">
                      {r.photoPath ? (
                        <a href={`/api/frame?readingId=${r.id}`} target="_blank" rel="noreferrer">
                          view
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {data.outbox && (
        <section className="card">
          <h2>Message outbox</h2>
          <p className="small muted">
            Recent Telegram messages{data.system.telegram === "log" ? " (not delivered: no bot token configured)" : ""}.
          </p>
          <pre className="log">
            {data.outbox.length === 0
              ? "No messages yet."
              : data.outbox
                  .map((m) => `[${fmt(m.createdAt)} → ${m.chatId}${m.error ? ` ✖ ${m.error}` : ""}]\n${m.text}`)
                  .join("\n\n")}
          </pre>
        </section>
      )}
    </>
  );
}

function PendingReading({
  r,
  busy,
  onConfirm,
  canSeePhoto,
}: {
  r: Reading;
  busy: boolean;
  onConfirm: (r: Reading, action: "accept" | "reject", level?: number) => void;
  canSeePhoto: boolean;
}) {
  const [custom, setCustom] = useState("");
  const photo = canSeePhoto && r.photoPath ? `/api/frame?readingId=${r.id}` : null;
  return (
    <div className="notice warn">
      <div className="row spread">
        <strong>{fmt(r.takenAt)}</strong>
        {photo && (
          <a href={photo} target="_blank" rel="noreferrer" className="small">
            open photo
          </a>
        )}
      </div>
      <div className="small">
        AI: {formatLevel(r.aiLevel)} · Observer: {formatLevel(r.observerLevel)}
        {r.observerName ? ` (${r.observerName})` : ""}
      </div>
      <div className="small muted">{r.statusReason}</div>
      {photo && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={photo} alt="Gauge photo" style={{ maxHeight: 240, marginTop: 8, borderRadius: 8 }} />
      )}
      <div className="row" style={{ marginTop: "0.6rem" }}>
        {r.aiLevel != null && (
          <button disabled={busy} onClick={() => onConfirm(r, "accept", r.aiLevel!)}>
            Accept {r.aiLevel.toFixed(2)} m (AI)
          </button>
        )}
        {r.observerLevel != null && r.observerLevel !== r.aiLevel && (
          <button disabled={busy} onClick={() => onConfirm(r, "accept", r.observerLevel!)}>
            Accept {r.observerLevel.toFixed(2)} m (observer)
          </button>
        )}
        <input
          type="number"
          step="0.01"
          inputMode="decimal"
          placeholder="Other level (m)"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          style={{ width: 150 }}
          aria-label="Other level in metres"
        />
        <button className="secondary" disabled={busy || custom === ""} onClick={() => onConfirm(r, "accept", Number(custom))}>
          Accept typed level
        </button>
        <button className="danger" disabled={busy} onClick={() => onConfirm(r, "reject")}>
          Reject
        </button>
      </div>
    </div>
  );
}
