"use client";

import { useEffect, useState } from "react";
import { api, useAdminToken } from "@/components/api";
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

interface System {
  ai: string;
  model: string | null;
  db: string;
  telegram: string;
  adminTokenRequired: boolean;
  adminOpen: boolean;
  isAdmin: boolean;
  lastTick: string | null;
}

export default function SetupPage() {
  const [stations, setStations] = useState<Station[]>([]);
  const [form, setForm] = useState<Station>(blank);
  const [team, setTeam] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [token, setToken] = useAdminToken();
  const [system, setSystem] = useState<System | null>(null);
  const bot = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;

  const load = async () => {
    const d = await api<{ stations: Station[]; system: System }>("/api/readings");
    setStations(d.stations);
    setSystem(d.system);
  };
  useEffect(() => {
    load().catch((e) => setMsg({ kind: "error", text: (e as Error).message }));
  }, []);

  const edit = (s: Station) => {
    setForm({ ...blank, ...s });
    setTeam(s.teamChatIds.join(", "));
    setMsg(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const num = (v: string) => (v === "" ? NaN : Number(v));
  const set = <K extends keyof Station>(k: K, v: Station[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setT = (k: keyof Station["thresholds"], v: string) =>
    setForm((f) => ({ ...f, thresholds: { ...f.thresholds, [k]: num(v) } }));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const station = {
        ...form,
        teamChatIds: team
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean),
      };
      await api("/api/stations", { method: "POST", json: station });
      setMsg({ kind: "ok", text: `Saved ${station.name}.` });
      await load();
    } catch (err) {
      setMsg({ kind: "error", text: (err as Error).message });
    }
  };

  const locked = system ? system.adminTokenRequired && !system.isAdmin : false;

  return (
    <>
      <h1>Setup</h1>

      {system && (
        <section className="card">
          <h2>System status</h2>
          <ul className="small" style={{ margin: 0, paddingLeft: "1.2rem" }}>
            <li>
              <strong>AI gauge reading:</strong>{" "}
              {system.ai === "live"
                ? `live (${system.model})`
                : "mock mode — set ANTHROPIC_API_KEY. Every real photo needs a human to confirm."}
            </li>
            <li>
              <strong>Database:</strong>{" "}
              {system.db === "supabase" ? "Supabase" : `local ${system.db} store — set SUPABASE_URL for production`}
            </li>
            <li>
              <strong>Telegram:</strong>{" "}
              {system.telegram === "live" ? "live" : "messages are only logged — set TELEGRAM_BOT_TOKEN"}
            </li>
            <li>
              <strong>Background job:</strong>{" "}
              {system.lastTick
                ? `last ran ${new Date(system.lastTick).toLocaleString("en-PH", { timeZone: "Asia/Manila" })}`
                : "never — reminders and the PAGASA check need npm run job:pagasa or a schedule hitting /api/cron"}
            </li>
          </ul>
          {system.adminOpen && (
            <div className="notice warn small">
              <strong>ADMIN_TOKEN is not set.</strong> Anyone who can open this site can edit stations and confirm or
              reject readings. A production build refuses admin actions until you set it.
            </div>
          )}
          <p className="small muted" style={{ margin: "0.5rem 0 0" }}>
            Health check: <code>/api/health</code>
          </p>
        </section>
      )}

      {system?.adminTokenRequired && (
        <div className="card">
          <label htmlFor="token">Admin token</label>
          <input
            id="token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="ADMIN_TOKEN"
            autoComplete="current-password"
          />
          <div className="row" style={{ marginTop: "0.5rem" }}>
            <button className="secondary" onClick={() => load().catch((e) => setMsg({ kind: "error", text: (e as Error).message }))}>
              Unlock
            </button>
            <span className="small muted">Saved in this browser only.</span>
          </div>
        </div>
      )}

      {locked && (
        <div className="notice warn">Enter the admin token above to see team chat IDs and edit stations.</div>
      )}

      <div className="grid" style={{ gridTemplateColumns: "minmax(240px, 1fr) minmax(300px, 2fr)" }}>
        <section className="card">
          <h2>Stations</h2>
          {stations.map((s) => (
            <div key={s.id} className="row spread" style={{ padding: "0.5rem 0", borderBottom: "1px solid var(--border)" }}>
              <div>
                <strong>{s.name}</strong>
                <div className="small muted">
                  {s.id} · {s.thresholds.alert}/{s.thresholds.alarm}/{s.thresholds.critical} m
                </div>
                {s.id !== "demo" && !locked && s.teamChatIds.length === 0 && (
                  <div className="small" style={{ color: "var(--alarm)", fontWeight: 600 }}>
                    ⚠ No observer team — nobody gets confirmation requests
                  </div>
                )}
                {s.id !== "demo" && !s.evacuationCenter && (
                  <div className="small muted">No evacuation center set — alerts can&apos;t say where to go</div>
                )}
              </div>
              <button className="secondary" onClick={() => edit(s)}>
                Edit
              </button>
            </div>
          ))}
          <button style={{ marginTop: "0.75rem" }} onClick={() => edit(blank)}>
            + New station
          </button>
        </section>

        <form className="card" onSubmit={save}>
          <h2>{form.createdAt ? `Edit ${form.name}` : "New station"}</h2>
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0 1rem" }}>
            <div>
              <label htmlFor="id">ID (used in links and Telegram)</label>
              <input
                id="id"
                value={form.id}
                onChange={(e) => set("id", e.target.value)}
                disabled={!!form.createdAt}
                required
                pattern="[a-z0-9-]+"
                placeholder="sto-nino"
              />
            </div>
            <div>
              <label htmlFor="name">Name</label>
              <input id="name" value={form.name} onChange={(e) => set("name", e.target.value)} required />
            </div>
            <div>
              <label htmlFor="river">River</label>
              <input id="river" value={form.river} onChange={(e) => set("river", e.target.value)} />
            </div>
            <div>
              <label htmlFor="location">Location</label>
              <input id="location" value={form.location} onChange={(e) => set("location", e.target.value)} />
            </div>
            <div>
              <label htmlFor="gmin">Gauge bottom (m)</label>
              <input id="gmin" type="number" step="0.01" value={form.gaugeMin} onChange={(e) => set("gaugeMin", num(e.target.value))} />
            </div>
            <div>
              <label htmlFor="gmax">Gauge top (m)</label>
              <input id="gmax" type="number" step="0.01" value={form.gaugeMax} onChange={(e) => set("gaugeMax", num(e.target.value))} />
            </div>
            <div>
              <label htmlFor="t1">1st alarm — Alert (m)</label>
              <input id="t1" type="number" step="0.01" value={form.thresholds.alert} onChange={(e) => setT("alert", e.target.value)} />
            </div>
            <div>
              <label htmlFor="t2">2nd alarm — Prepare (m)</label>
              <input id="t2" type="number" step="0.01" value={form.thresholds.alarm} onChange={(e) => setT("alarm", e.target.value)} />
            </div>
            <div>
              <label htmlFor="t3">3rd alarm — Evacuate (m)</label>
              <input id="t3" type="number" step="0.01" value={form.thresholds.critical} onChange={(e) => setT("critical", e.target.value)} />
            </div>
            <div>
              <label htmlFor="tol">AI/observer tolerance (m)</label>
              <input id="tol" type="number" step="0.01" value={form.tolerance} onChange={(e) => set("tolerance", num(e.target.value))} />
            </div>
            <div>
              <label htmlFor="rate">Fastest plausible rise (m/h)</label>
              <input id="rate" type="number" step="0.1" value={form.maxRatePerHour} onChange={(e) => set("maxRatePerHour", num(e.target.value))} />
            </div>
          </div>

          <label htmlFor="evac">Evacuation center (printed in 2nd/3rd alarm messages)</label>
          <input
            id="evac"
            value={form.evacuationCenter}
            onChange={(e) => set("evacuationCenter", e.target.value)}
            placeholder="Barangay Hall covered court"
          />
          <label htmlFor="hotline">Hotline (printed in every alert)</label>
          <input id="hotline" value={form.hotline} onChange={(e) => set("hotline", e.target.value)} placeholder="MDRRMO 0999-000-0000" />

          <label htmlFor="team">Observer team Telegram chat IDs</label>
          <textarea id="team" rows={2} value={team} onChange={(e) => setTeam(e.target.value)} placeholder="123456789, 987654321" />
          <p className="small muted" style={{ marginTop: 4 }}>
            Team members receive confirmation requests and reading reminders, and can confirm readings from Telegram.
            Each person gets their ID by sending <code>/myid</code> to the bot. In a group, use each person&apos;s own
            user ID so the two-person rule still works.
          </p>
          {msg && <div className={`notice ${msg.kind}`}>{msg.text}</div>}
          <button type="submit" style={{ marginTop: "0.5rem" }}>
            Save station
          </button>
        </form>
      </div>

      <section className="card">
        <h2>Telegram</h2>
        <ol className="steps small">
          <li>
            Create a bot with <a href="https://t.me/BotFather">@BotFather</a> and put the token in{" "}
            <code>TELEGRAM_BOT_TOKEN</code>.
          </li>
          <li>
            Set <code>TELEGRAM_WEBHOOK_SECRET</code> to a long random string. It is required: without it anyone who
            finds the webhook URL could confirm readings and trigger alerts.
          </li>
          <li>
            Point the bot at this server:{" "}
            <code>
              curl &quot;https://api.telegram.org/bot&lt;TOKEN&gt;/setWebhook?url=&lt;PUBLIC_BASE_URL&gt;/api/telegram&amp;secret_token=&lt;TELEGRAM_WEBHOOK_SECRET&gt;&quot;
            </code>
          </li>
          <li>
            Residents subscribe with{" "}
            {bot ? (
              stations
                .filter((s) => s.id !== "demo")
                .map((s) => (
                  <span key={s.id}>
                    <a href={`https://t.me/${bot}?start=${s.id}`}>
                      t.me/{bot}?start={s.id}
                    </a>{" "}
                  </span>
                ))
            ) : (
              <code>/subscribe &lt;station-id&gt;</code>
            )}
            .
          </li>
        </ol>
      </section>

      <section className="card">
        <h2>Privacy</h2>
        <ul className="small muted" style={{ margin: 0, paddingLeft: "1.2rem" }}>
          <li>Gauge photos are served only to the observer team and deleted after PHOTO_RETENTION_DAYS (default 30).</li>
          <li>Volunteer names are shown to the team; the public dashboard sees an initial only.</li>
          <li>Residents&apos; Telegram chat IDs are stored only to send alerts and removed by /stop.</li>
        </ul>
      </section>
    </>
  );
}
