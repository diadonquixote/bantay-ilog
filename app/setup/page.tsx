"use client";

import { useEffect, useState } from "react";
import { api, useAdminToken } from "@/components/api";
import { StaffGauge } from "@/components/StaffGauge";
import type { Station } from "@/lib/schemas";

const blank: Station = {
  id: "",
  name: "",
  river: "",
  location: "",
  gaugeMin: 0,
  gaugeMax: 10,
  thresholds: { alert: 5, alarm: 6, critical: 7 },
  tolerance: 0.1,
  maxRatePerHour: 2,
  evacuationCenter: "",
  hotline: "",
  teamChatIds: [],
};

interface SystemInfo {
  adminTokenRequired: boolean;
  adminOpen: boolean;
  isAdmin: boolean;
  lastTick: string | null;
  ai: string;
  model: string | null;
  db: string;
  telegram: string;
}

function problemsWith(f: Station): string[] {
  const p: string[] = [];
  const t = f.thresholds;
  if ([f.gaugeMin, f.gaugeMax, t.alert, t.alarm, t.critical, f.tolerance, f.maxRatePerHour].some((v) => !Number.isFinite(v))) {
    p.push("Fill in every number.");
    return p;
  }
  if (f.gaugeMin >= f.gaugeMax) p.push("The gauge bottom must be below the top.");
  if (!(t.alert < t.alarm && t.alarm < t.critical)) p.push("Alarm levels must go up: 1st < 2nd < 3rd.");
  if (t.alert < f.gaugeMin || t.critical > f.gaugeMax) p.push("Alarm levels should be within the painted gauge.");
  return p;
}

export default function SetupPage() {
  const [stations, setStations] = useState<Station[]>([]);
  const [form, setForm] = useState<Station>(blank);
  const [team, setTeam] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [token, setToken] = useAdminToken();
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const bot = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;

  const load = async () => {
    const d = await api<{ stations: Station[]; system: SystemInfo }>("/api/readings");
    setStations(d.stations);
    setSystem(d.system);
    return d.stations;
  };
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load() only sets state after awaiting the network
    load()
      .then((list) => {
        const first = list.find((s) => s.id !== "demo");
        if (first) edit(first);
      })
      .catch((e) => setMsg({ kind: "error", text: (e as Error).message }));
  }, []);

  function edit(s: Station) {
    setForm({ ...blank, ...s });
    setTeam(s.teamChatIds.join(", "));
    setMsg(null);
  }

  const num = (v: string) => (v === "" ? NaN : Number(v));
  const set = <K extends keyof Station>(k: K, v: Station[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setT = (k: keyof Station["thresholds"], v: string) =>
    setForm((f) => ({ ...f, thresholds: { ...f.thresholds, [k]: num(v) } }));

  const problems = problemsWith(form);
  const isNew = !form.createdAt;
  const locked = system ? system.adminTokenRequired && !system.isAdmin : false;
  const unlock = () => load().catch((e) => setMsg({ kind: "error", text: (e as Error).message }));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (problems.length) return;
    try {
      const station = {
        ...form,
        teamChatIds: team
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean),
      };
      const res = await api<{ station: Station }>("/api/stations", { method: "POST", json: station });
      await load();
      edit(res.station);
      setMsg({ kind: "ok", text: `Saved ${station.name}.` });
    } catch (err) {
      setMsg({ kind: "error", text: (err as Error).message });
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Setup</h1>
          <p className="muted">Gauge stations, alarm levels and the observer team. For the barangay DRRM coordinator.</p>
        </div>
      </div>

      {system?.adminOpen && (
        <div className="notice warn">
          <strong>Anyone who can open this site can change these settings.</strong> Set <code>ADMIN_TOKEN</code> on the server
          before putting the app on the internet. A production build refuses admin actions until you set it.
        </div>
      )}
      {locked && (
        <section className="card" aria-labelledby="unlock-h">
          <h2 id="unlock-h">Sign in to change settings</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            Enter the admin token to see team chat IDs and edit stations. It is remembered on this device only.
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
            <button onClick={unlock}>Unlock</button>
          </div>
        </section>
      )}

      <div className="setup-layout">
        <section className="card" aria-labelledby="stations-h">
          <h2 id="stations-h">Stations</h2>
          <ul className="station-list">
            {stations.map((s) => (
              <li key={s.id}>
                <button aria-current={form.id === s.id && !isNew ? "true" : undefined} onClick={() => edit(s)}>
                  <span>
                    <strong>{s.name}</strong>
                    <span className="small muted" style={{ display: "block" }}>
                      {s.river || s.id} · alarms <span className="data">{s.thresholds.alert}/{s.thresholds.alarm}/{s.thresholds.critical} m</span>
                    </span>
                    {s.id !== "demo" && !locked && s.teamChatIds.length === 0 && (
                      <span className="small" style={{ display: "block", color: "var(--stage-alarm-ink)", fontWeight: 700 }}>
                        No observer team yet
                      </span>
                    )}
                    {s.id !== "demo" && !s.evacuationCenter && (
                      <span className="small muted" style={{ display: "block" }}>
                        No evacuation center — alerts can&apos;t say where to go
                      </span>
                    )}
                  </span>
                  <span aria-hidden="true">›</span>
                </button>
              </li>
            ))}
          </ul>
          <button className="secondary" style={{ marginTop: "0.8rem", width: "100%" }} onClick={() => edit(blank)}>
            + Add a station
          </button>
        </section>

        <form className="card" onSubmit={save} aria-labelledby="form-h" noValidate>
          <h2 id="form-h">{isNew ? "New station" : form.name}</h2>

          <fieldset>
            <legend>Station</legend>
            <div className="fields">
              <div>
                <label htmlFor="name">Name</label>
                <input id="name" value={form.name} onChange={(e) => set("name", e.target.value)} required placeholder="Sto. Niño Gauge" />
              </div>
              <div>
                <label htmlFor="id">Short ID</label>
                <input
                  id="id"
                  value={form.id}
                  onChange={(e) => set("id", e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
                  disabled={!isNew}
                  required
                  placeholder="sto-nino"
                  aria-describedby="id-hint"
                />
                <p className="hint" id="id-hint">
                  Used in links and Telegram. Can&apos;t be changed later.
                </p>
              </div>
              <div>
                <label htmlFor="river">River</label>
                <input id="river" value={form.river} onChange={(e) => set("river", e.target.value)} placeholder="Marikina River" />
              </div>
              <div>
                <label htmlFor="location">Where the gauge is</label>
                <input id="location" value={form.location} onChange={(e) => set("location", e.target.value)} placeholder="Sto. Niño bridge" />
              </div>
            </div>
          </fieldset>

          <fieldset>
            <legend>Gauge and alarm levels (metres, as painted on the gauge)</legend>
            <div className="threshold-editor">
              <div className="fields">
                <div>
                  <label htmlFor="gmin">Lowest mark</label>
                  <input id="gmin" type="number" step="0.01" inputMode="decimal" value={form.gaugeMin} onChange={(e) => set("gaugeMin", num(e.target.value))} />
                </div>
                <div>
                  <label htmlFor="gmax">Highest mark</label>
                  <input id="gmax" type="number" step="0.01" inputMode="decimal" value={form.gaugeMax} onChange={(e) => set("gaugeMax", num(e.target.value))} />
                </div>
                <div>
                  <label htmlFor="t1" style={{ color: "var(--stage-alert-ink)" }}>
                    1st alarm · be alert
                  </label>
                  <input id="t1" type="number" step="0.01" inputMode="decimal" value={form.thresholds.alert} onChange={(e) => setT("alert", e.target.value)} />
                </div>
                <div>
                  <label htmlFor="t2" style={{ color: "var(--stage-alarm-ink)" }}>
                    2nd alarm · prepare to evacuate
                  </label>
                  <input id="t2" type="number" step="0.01" inputMode="decimal" value={form.thresholds.alarm} onChange={(e) => setT("alarm", e.target.value)} />
                </div>
                <div>
                  <label htmlFor="t3" style={{ color: "var(--stage-critical-ink)" }}>
                    3rd alarm · evacuate now
                  </label>
                  <input id="t3" type="number" step="0.01" inputMode="decimal" value={form.thresholds.critical} onChange={(e) => setT("critical", e.target.value)} />
                </div>
                <div>
                  <label htmlFor="rate">Fastest plausible rise (m per hour)</label>
                  <input id="rate" type="number" step="0.1" inputMode="decimal" value={form.maxRatePerHour} onChange={(e) => set("maxRatePerHour", num(e.target.value))} aria-describedby="rate-hint" />
                  <p className="hint" id="rate-hint">
                    Faster jumps are held for a person to check.
                  </p>
                </div>
                <div>
                  <label htmlFor="tol">Allowed difference, AI vs observer</label>
                  <input id="tol" type="number" step="0.01" inputMode="decimal" value={form.tolerance} onChange={(e) => set("tolerance", num(e.target.value))} aria-describedby="tol-hint" />
                  <p className="hint" id="tol-hint">
                    Bigger differences go to a team member. 0.10 m = one painted block.
                  </p>
                </div>
              </div>
              <div aria-label="Preview of the alarm lines on the gauge">
                {problems.length === 0 ? (
                  <StaffGauge station={form} level={null} height={240} />
                ) : (
                  <div className="notice error small" role="alert" style={{ maxWidth: 220 }}>
                    {problems.map((p) => (
                      <div key={p}>{p}</div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </fieldset>

          <fieldset>
            <legend>What alerts tell residents</legend>
            <div className="fields">
              <div>
                <label htmlFor="evac">Evacuation center</label>
                <input
                  id="evac"
                  value={form.evacuationCenter}
                  onChange={(e) => set("evacuationCenter", e.target.value)}
                  placeholder="Barangay Hall covered court"
                  aria-describedby="evac-hint"
                />
                <p className="hint" id="evac-hint">
                  Printed in 2nd and 3rd alarm messages.
                </p>
              </div>
              <div>
                <label htmlFor="hotline">Hotline</label>
                <input
                  id="hotline"
                  value={form.hotline}
                  onChange={(e) => set("hotline", e.target.value)}
                  placeholder="MDRRMO 0999-000-0000"
                  aria-describedby="hotline-hint"
                />
                <p className="hint" id="hotline-hint">
                  Printed in every alert.
                </p>
              </div>
            </div>
          </fieldset>

          <fieldset>
            <legend>Observer team</legend>
            <label htmlFor="team">Telegram chat IDs, separated by commas</label>
            <textarea id="team" rows={2} value={team} onChange={(e) => setTeam(e.target.value)} placeholder="123456789, 987654321" aria-describedby="team-hint" />
            <p className="hint" id="team-hint">
              These people are asked to confirm doubtful readings and reminded to take readings when the river is high. Each
              person sends <code>/myid</code> to the bot to get their number. In a group, use each person&apos;s own user ID so
              the two-person rule still works.
            </p>
          </fieldset>

          {msg && (
            <div className={`notice ${msg.kind}`} role={msg.kind === "error" ? "alert" : "status"}>
              {msg.text}
            </div>
          )}
          <div className="row" style={{ marginTop: "1rem" }}>
            <button type="submit" disabled={locked || problems.length > 0 || !form.name || !form.id}>
              {isNew ? "Add station" : "Save changes"}
            </button>
          </div>
        </form>
      </div>

      {system && (
        <section className="card" aria-labelledby="system-h">
          <h2 id="system-h">Connected services</h2>
          <ul className="status-list">
            <li>
              <span className={`dot ${system.ai === "live" ? "on" : "off"}`} aria-hidden="true" />
              <span>
                <strong>AI gauge reading:</strong>{" "}
                {system.ai === "live" ? (
                  <>on ({system.model})</>
                ) : (
                  <>off — every photo needs a person to confirm it. Set <code>ANTHROPIC_API_KEY</code> to turn it on.</>
                )}
              </span>
            </li>
            <li>
              <span className={`dot ${system.telegram === "live" ? "on" : "off"}`} aria-hidden="true" />
              <span>
                <strong>Telegram alerts:</strong>{" "}
                {system.telegram === "live" ? "on" : <>off — messages are only logged. Set <code>TELEGRAM_BOT_TOKEN</code>.</>}
              </span>
            </li>
            <li>
              <span className={`dot ${system.lastTick ? "on" : "off"}`} aria-hidden="true" />
              <span>
                <strong>Background job:</strong>{" "}
                {system.lastTick ? (
                  <>last ran {new Date(system.lastTick).toLocaleString("en-PH", { timeZone: "Asia/Manila" })}</>
                ) : (
                  <>
                    never — reminders and the PAGASA check need <code>npm run job:pagasa</code> or a schedule calling{" "}
                    <code>/api/cron</code>.
                  </>
                )}
              </span>
            </li>
            <li>
              <span className={`dot ${system.db === "supabase" ? "on" : "off"}`} aria-hidden="true" />
              <span>
                <strong>Database:</strong>{" "}
                {system.db === "supabase" ? "Supabase" : <>saved to a file on this server. Use Supabase for a real deployment.</>}
              </span>
            </li>
          </ul>
          <p className="hint">
            Health check: <code>/api/health</code>
          </p>
        </section>
      )}

      <details className="card more">
        <summary>Connecting the Telegram bot</summary>
        <ol className="how">
          <li>
            Create a bot with <a href="https://t.me/BotFather">@BotFather</a> and set <code>TELEGRAM_BOT_TOKEN</code>.
          </li>
          <li>
            Set <code>TELEGRAM_WEBHOOK_SECRET</code> to a long random string. It is required: without it anyone who finds
            the webhook URL could confirm readings and trigger alerts.
          </li>
          <li>
            Point it at this server:{" "}
            <code>
              https://api.telegram.org/bot&lt;TOKEN&gt;/setWebhook?url=&lt;PUBLIC_BASE_URL&gt;/api/telegram&amp;secret_token=&lt;TELEGRAM_WEBHOOK_SECRET&gt;
            </code>
          </li>
          <li>
            Share the subscribe link with residents:{" "}
            {bot ? (
              stations
                .filter((s) => s.id !== "demo")
                .map((s) => (
                  <span key={s.id}>
                    <a href={`https://t.me/${bot}?start=${s.id}`}>t.me/{bot}?start={s.id}</a>{" "}
                  </span>
                ))
            ) : (
              <>
                set <code>NEXT_PUBLIC_TELEGRAM_BOT_USERNAME</code> to show it here, or tell residents to send{" "}
                <code>/subscribe &lt;station-id&gt;</code>.
              </>
            )}
          </li>
        </ol>
      </details>

      <section className="card" aria-labelledby="privacy-h">
        <h2 id="privacy-h">Privacy</h2>
        <ul className="status-list">
          <li>Gauge photos are shown only to the observer team and deleted after PHOTO_RETENTION_DAYS (default 30).</li>
          <li>Volunteer names are shown to the team; the public dashboard sees an initial only.</li>
          <li>Residents&apos; Telegram chat IDs are stored only to send alerts and removed by /stop.</li>
        </ul>
      </section>
    </>
  );
}
