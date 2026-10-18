"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, useAdminToken } from "@/components/api";
import { readLocal, useClientValue, writeLocal } from "@/components/hooks";
import { LevelBadge, stageStyle } from "@/components/LevelBadge";
import { LevelChart } from "@/components/LevelChart";
import { StationStatusPanel, DEFAULT_STALE_MIN, type PanelPending, type PanelTrend } from "@/components/StationStatusPanel";
import { TeamPhoto } from "@/components/TeamPhoto";
import { formatManila, TimeAgo } from "@/components/TimeAgo";
import { formatLevel } from "@/lib/levels";
import type { Advisory, Alert, LevelKey, OutboxMessage, Reading, Station } from "@/lib/schemas";

interface DashboardData {
  station: Station;
  stations: Station[];
  system: {
    ai: string;
    model: string | null;
    db: string;
    telegram: string;
    adminTokenRequired: boolean;
    /** Admin actions unprotected (dev only). */
    adminOpen: boolean;
    /** This browser sent a valid admin token (or the app is open). */
    isAdmin: boolean;
    /** Last run of the reminders/PAGASA job. */
    lastTick: string | null;
  };
  status: {
    latest: Reading | null;
    stage: LevelKey | null;
    ageMinutes: number | null;
    trend: PanelTrend & { samples: number };
    pendingConfirmations: number;
    pendingHighest: (PanelPending & { readingId: string }) | null;
  };
  readings: Reading[];
  alerts: Alert[];
  advisory: Advisory | null;
  subscriberCount: number;
  outbox: OutboxMessage[] | null;
}

const RANGES = [
  { hours: 6, label: "6 h" },
  { hours: 24, label: "24 h" },
  { hours: 72, label: "3 days" },
  { hours: 168, label: "7 days" },
];

const WARNING_LABEL: Record<string, string> = {
  red: "RED rainfall warning",
  orange: "ORANGE rainfall warning",
  yellow: "YELLOW rainfall warning",
  none: "No rainfall warning",
  unknown: "Rainfall warning unknown",
};

export default function Dashboard() {
  // Station from the link (?station=…) until one is picked; nothing is fetched until hydrated.
  const urlStation = useClientValue(() => new URLSearchParams(window.location.search).get("station"), null);
  const hydrated = useClientValue(() => true, false);
  const [picked, setStationId] = useState<string | null>(null);
  const stationId = picked ?? urlStation;
  const [hours, setHours] = useState(24);
  const [data, setData] = useState<DashboardData | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const savedName = useClientValue(() => readLocal("bantay-name"), "");
  const [nameEdit, setName] = useState<string | null>(null);
  const name = nameEdit ?? savedName;
  const [token, setToken] = useAdminToken();
  const [sound, setSound] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);

  const load = useCallback(async () => {
    if (!hydrated) return;
    try {
      if (!stationId) {
        // No station in the link: open the first real station.
        const list = await api<{ stations: Station[] }>("/api/readings");
        const pick = list.stations.find((s) => s.id !== "demo") ?? list.stations[0];
        if (pick) setStationId(pick.id);
        else setError("No gauge stations are set up yet.");
        return;
      }
      setData(await api<DashboardData>(`/api/readings?stationId=${encodeURIComponent(stationId)}&hours=${hours}`));
      setLoadedAt(new Date().toISOString());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [hydrated, stationId, hours, token]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh every 20 s while the page is on screen; a hidden tab costs no data or battery.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load() only sets state after awaiting the network
    load();
    const t = setInterval(() => document.visibilityState === "visible" && load(), 20_000);
    const onShow = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onShow);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [load]);

  const stage = data?.status.stage ?? null;
  useEffect(() => {
    if (sound && stage === "critical") audio.current?.play().catch(() => {});
  }, [sound, stage, data?.status.latest?.id]);

  const selectStation = (id: string) => {
    setStationId(id);
    setData(null);
    window.history.replaceState(null, "", `?station=${id}`);
  };

  const confirm = async (r: Reading, action: "accept" | "reject", level?: number) => {
    if (!name.trim()) {
      setError("Type your name first — it is recorded with the confirmation.");
      document.getElementById("confirmer-name")?.focus();
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
      <div aria-busy="true">
        {error ? (
          <div className="card">
            <div className="notice error" role="alert">
              {error}
            </div>
            <button className="secondary" onClick={load}>
              Try again
            </button>
          </div>
        ) : (
          <div className="card">
            <div className="skeleton" style={{ width: "40%" }} />
            <div className="skeleton" style={{ width: "30%", minHeight: "3.5rem", marginTop: "0.8rem" }} />
            <div className="skeleton" style={{ width: "60%", marginTop: "0.8rem" }} />
          </div>
        )}
      </div>
    );
  }

  const { station, status, system } = data;
  const pending = data.readings.filter((r) => r.status === "needs_confirmation");
  const needsToken = system.adminTokenRequired && !system.isAdmin;
  const stale = status.ageMinutes != null && status.ageMinutes > DEFAULT_STALE_MIN;

  return (
    <>
      <audio ref={audio} src="/audio/alarm.wav" preload="none" />

      <div className="page-head" style={{ alignItems: "center" }}>
        <div className="row">
          <label htmlFor="station-pick" className="eyebrow" style={{ margin: 0 }}>
            Station
          </label>
          <select id="station-pick" value={station.id} onChange={(e) => selectStation(e.target.value)} style={{ width: "auto" }}>
            {data.stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} — {s.river}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <div className="segmented" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button key={r.hours} aria-pressed={hours === r.hours} onClick={() => setHours(r.hours)}>
                {r.label}
              </button>
            ))}
          </div>
          <label className="switch">
            <input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} />
            Siren at 3rd alarm
          </label>
        </div>
      </div>

      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {needsToken && (
        <section className="card" aria-labelledby="signin-h">
          <h2 id="signin-h">Team sign-in</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            Volunteer names and gauge photos are shown only to the observer team, and confirming a reading needs the
            token too.
          </p>
          <div className="row" style={{ maxWidth: 480 }}>
            <label htmlFor="token" className="sr-only">
              Admin token
            </label>
            <input
              id="token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Admin token"
              autoComplete="current-password"
              style={{ flex: 1 }}
            />
            <button onClick={load}>Unlock</button>
          </div>
        </section>
      )}
      {system.adminOpen && (
        <div className="notice warn small">
          <strong>ADMIN_TOKEN is not set.</strong> Anyone who can open this page can confirm readings. Set it before
          putting the app on the internet.
        </div>
      )}
      {system.isAdmin && station.teamChatIds.length === 0 && (
        <div className="notice warn">
          <strong>No observer team for this station.</strong> Nobody is notified when a reading needs confirmation.{" "}
          <a href="/setup">Add team members in Setup</a>.
        </div>
      )}

      <StationStatusPanel
        station={station}
        latest={status.latest}
        stage={status.stage}
        trend={status.trend}
        pending={status.pendingHighest}
        ageMinutes={status.ageMinutes}
        headingLevel={1}
      >
        <div className="status-meta" style={{ marginTop: "0.4rem" }}>
          <span>
            PAGASA: <strong>{data.advisory ? WARNING_LABEL[data.advisory.warning] : "no advisory on record"}</strong>
          </span>
          <span>
            <strong>{data.subscriberCount}</strong> resident{data.subscriberCount === 1 ? "" : "s"} subscribed
            {system.isAdmin && (
              <>
                {" "}
                · <strong>{station.teamChatIds.length}</strong> on the observer team
              </>
            )}
          </span>
          <span>
            Background job:{" "}
            {system.lastTick ? (
              <>
                last ran <TimeAgo iso={system.lastTick} />
              </>
            ) : (
              "has not run yet"
            )}
          </span>
          {loadedAt && (
            <span>
              Live · refreshed <TimeAgo iso={loadedAt} />
            </span>
          )}
        </div>
      </StationStatusPanel>

      {stale && (
        <div className="notice warn">
          The alert agent will not warn residents from a stale number — <strong>ask the team for a new photo</strong>.
        </div>
      )}

      {pending.length > 0 && (
        <section className="card" style={{ borderColor: "var(--stage-alarm)", borderWidth: 2 }} aria-labelledby="pending-h">
          <h2 id="pending-h">
            Waiting for confirmation <span className="pill needs_confirmation">{pending.length}</span>
          </h2>
          <p className="hint" style={{ marginTop: 0 }}>
            Residents are alerted only after a reading is confirmed. You can&apos;t confirm a reading you sent yourself.
          </p>
          <div className="fields" style={{ maxWidth: 560 }}>
            <div>
              <label htmlFor="confirmer-name">Your name</label>
              <input
                id="confirmer-name"
                value={name}
                autoComplete="name"
                onChange={(e) => {
                  setName(e.target.value);
                  writeLocal("bantay-name", e.target.value);
                }}
              />
            </div>
            {data.system.adminTokenRequired && (
              <div>
                <label htmlFor="confirm-token">Admin token</label>
                <input id="confirm-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} />
              </div>
            )}
          </div>
          {pending.map((r) => (
            <PendingReading key={r.id} r={r} busy={busy === r.id} onConfirm={confirm} canSeePhoto={system.isAdmin} />
          ))}
        </section>
      )}

      <section className="card" aria-labelledby="chart-h">
        <h2 id="chart-h">Water level, last {RANGES.find((r) => r.hours === hours)?.label}</h2>
        <LevelChart station={station} readings={data.readings} hours={hours} />
      </section>

      <section className="card below-fold" aria-labelledby="alerts-h">
        <h2 id="alerts-h">Alerts sent to residents</h2>
        {data.alerts.length === 0 ? (
          <p className="muted">No alerts in this period.</p>
        ) : (
          data.alerts.map((a) => (
            <article key={a.id} className="alert-item" style={stageStyle(a.level)}>
              <div className="row small muted">
                <LevelBadge stage={a.level} />
                <span className="pill">{a.kind}</span>
                <span className="data">{formatManila(a.createdAt)}</span>
                <span>
                  {a.origin === "agent" ? "the alert agent chose to send it" : "sent by rule"} · reached {a.recipients} chat
                  {a.recipients === 1 ? "" : "s"}
                </span>
              </div>
              <div className="msg">{a.message}</div>
            </article>
          ))
        )}
      </section>

      <section className="card below-fold" aria-labelledby="readings-h">
        <h2 id="readings-h">All readings</h2>
        {data.readings.length === 0 ? (
          <p className="muted">No readings in this period.</p>
        ) : (
          <div className="table-wrap">
            <table className="stack-on-phone">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Level</th>
                  <th>AI read</th>
                  <th>Observer</th>
                  <th>Status</th>
                  {system.isAdmin && <th>Photo</th>}
                </tr>
              </thead>
              <tbody>
                {data.readings.map((r) => (
                  <tr key={r.id}>
                    <td className="num" data-label="Time">
                      {formatManila(r.takenAt)}
                    </td>
                    <td className="num" data-label="Level">
                      <strong>{formatLevel(r.level)}</strong>
                    </td>
                    <td className="num" data-label="AI read">
                      {formatLevel(r.aiLevel)}
                      {r.aiConfidence != null && <span className="muted"> ({Math.round(r.aiConfidence * 100)}%)</span>}
                    </td>
                    <td className="num" data-label="Observer">
                      {formatLevel(r.observerLevel)}
                      {r.observerName && <div className="muted">{r.observerName}</div>}
                    </td>
                    <td data-label="Status">
                      <span className={`pill ${r.status}`}>{r.status.replace("_", " ")}</span>
                      <div className="muted small">{r.statusReason}</div>
                    </td>
                    {system.isAdmin && (
                      <td data-label="Photo">
                        {r.photoPath ? <PhotoCell readingId={r.id} takenAt={r.takenAt} /> : <span className="muted">—</span>}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {data.outbox && (
        <details className="card more">
          <summary>Message log ({data.outbox.length})</summary>
          <p className="hint">
            Recent Telegram messages
            {data.system.telegram === "log" ? " — not delivered, because no bot token is configured." : "."}
          </p>
          <pre className="log">
            {data.outbox.length === 0
              ? "No messages yet."
              : data.outbox
                  .map((m) => `[${formatManila(m.createdAt)} → ${m.chatId}${m.error ? ` ✖ ${m.error}` : ""}]\n${m.text}`)
                  .join("\n\n")}
          </pre>
        </details>
      )}
    </>
  );
}

/** Photos load only when asked for: each one is a team-only, token-checked download. */
function PhotoCell({ readingId, takenAt }: { readingId: string; takenAt: string }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button className="ghost" style={{ minHeight: 32, padding: "0 0.3rem" }} onClick={() => setOpen(true)}>
        Show photo
      </button>
    );
  }
  return (
    <TeamPhoto
      readingId={readingId}
      alt={`Gauge photo sent ${formatManila(takenAt)}`}
      style={{ width: 90, maxHeight: 150, objectFit: "cover", borderRadius: 6, display: "block" }}
    />
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
  const showPhoto = canSeePhoto && !!r.photoPath;
  return (
    <article className="notice warn" style={{ display: "grid", gridTemplateColumns: showPhoto ? "auto 1fr" : "1fr", gap: "1rem" }}>
      {showPhoto && (
        <TeamPhoto
          readingId={r.id}
          alt={`Gauge photo sent ${formatManila(r.takenAt)}`}
          style={{ width: 110, maxHeight: 190, objectFit: "cover", borderRadius: 8, display: "block" }}
        />
      )}
      <div>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <strong className="data">{formatManila(r.takenAt)}</strong>
          <span className="small muted">
            <TimeAgo iso={r.takenAt} />
          </span>
        </div>
        <div style={{ margin: "0.3rem 0" }}>
          AI read <strong className="data">{formatLevel(r.aiLevel)}</strong> · {r.observerName ?? "Observer"} saw{" "}
          <strong className="data">{formatLevel(r.observerLevel)}</strong>
        </div>
        <div className="small muted">{r.statusReason}</div>
        <div className="row" style={{ marginTop: "0.6rem" }}>
          {r.aiLevel != null && (
            <button disabled={busy} onClick={() => onConfirm(r, "accept", r.aiLevel!)}>
              Accept {r.aiLevel.toFixed(2)} m
            </button>
          )}
          {r.observerLevel != null && r.observerLevel !== r.aiLevel && (
            <button disabled={busy} onClick={() => onConfirm(r, "accept", r.observerLevel!)}>
              Accept {r.observerLevel.toFixed(2)} m
            </button>
          )}
          <button className="danger" disabled={busy} onClick={() => onConfirm(r, "reject")}>
            Reject
          </button>
        </div>
        <div className="row" style={{ marginTop: "0.5rem" }}>
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            aria-label="A different level in metres"
            placeholder="Other level (m)"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            style={{ width: 170 }}
          />
          <button className="secondary" disabled={busy || custom === ""} onClick={() => onConfirm(r, "accept", Number(custom))}>
            Accept this level
          </button>
        </div>
      </div>
    </article>
  );
}
