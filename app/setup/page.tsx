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
  teamChatIds: [],
};

export default function SetupPage() {
  const [stations, setStations] = useState<Station[]>([]);
  const [form, setForm] = useState<Station>(blank);
  const [team, setTeam] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [token, setToken] = useAdminToken();
  const [adminRequired, setAdminRequired] = useState(false);
  const [system, setSystem] = useState<{ ai: string; model: string | null; db: string; telegram: string } | null>(null);
  const bot = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;

  const load = async () => {
    const d = await api<{
      stations: Station[];
      system: { adminTokenRequired: boolean; ai: string; model: string | null; db: string; telegram: string };
    }>("/api/readings");
    setStations(d.stations);
    setAdminRequired(d.system.adminTokenRequired);
    setSystem(d.system);
  };
  useEffect(() => {
    load().catch((e) => setMsg({ kind: "error", text: (e as Error).message }));
  }, []);

  const edit = (s: Station) => {
    setForm(s);
    setTeam(s.teamChatIds.join(", "));
    setMsg(null);
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

  return (
    <>
      <h1>Setup</h1>

      {system && (
        <section className="card">
          <h2>System status</h2>
          <ul className="small" style={{ margin: 0, paddingLeft: "1.2rem" }}>
            <li>
              <strong>AI gauge reading:</strong>{" "}
              {system.ai === "live" ? `live (${system.model})` : "mock mode — set ANTHROPIC_API_KEY. Every real photo needs a human to confirm."}
            </li>
            <li>
              <strong>Database:</strong> {system.db === "supabase" ? "Supabase" : `local ${system.db} store — set SUPABASE_URL for production`}
            </li>
            <li>
              <strong>Telegram:</strong> {system.telegram === "live" ? "live" : "messages are only logged — set TELEGRAM_BOT_TOKEN"}
            </li>
          </ul>
          {!adminRequired && (
            <div className="notice warn small">
              <strong>ADMIN_TOKEN is not set.</strong> Anyone who can open this site can edit stations and confirm or reject
              readings. Set it before putting the app on the internet.
            </div>
          )}
        </section>
      )}

      {adminRequired && (
        <div className="card">
          <label htmlFor="token">Admin token</label>
          <input id="token" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="ADMIN_TOKEN" />
          <p className="small muted">Saved in this browser only. Needed to edit stations and confirm readings.</p>
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: "minmax(240px, 1fr) minmax(300px, 2fr)" }}>
        <section className="card">
          <h2>Stations</h2>
          {stations.map((s) => (
            <div key={s.id} className="row" style={{ justifyContent: "space-between", padding: "0.4rem 0", borderBottom: "1px solid var(--border)" }}>
              <div>
                <strong>{s.name}</strong>
                <div className="small muted">
                  {s.id} · {s.thresholds.alert}/{s.thresholds.alarm}/{s.thresholds.critical} m
                </div>
                {s.id !== "demo" && s.teamChatIds.length === 0 && (
                  <div className="small" style={{ color: "var(--alarm)", fontWeight: 600 }}>
                    ⚠ No observer team — nobody gets confirmation requests
                  </div>
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
              <input id="id" value={form.id} onChange={(e) => set("id", e.target.value)} disabled={!!form.createdAt} required pattern="[a-z0-9-]+" placeholder="sto-nino" />
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
          </div>
          <label htmlFor="team">Observer team Telegram chat IDs</label>
          <textarea id="team" rows={2} value={team} onChange={(e) => setTeam(e.target.value)} placeholder="123456789, 987654321" />
          <p className="small muted" style={{ marginTop: 4 }}>
            Team members receive confirmation requests and reading reminders, and can confirm readings from Telegram. Each person
            gets their chat ID by sending <code>/myid</code> to the bot.
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
            Create a bot with <a href="https://t.me/BotFather">@BotFather</a> and put the token in <code>TELEGRAM_BOT_TOKEN</code>.
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
                    <a href={`https://t.me/${bot}?start=${s.id}`}>t.me/{bot}?start={s.id}</a>{" "}
                  </span>
                ))
            ) : (
              <code>/subscribe &lt;station-id&gt;</code>
            )}
            .
          </li>
        </ol>
      </section>
    </>
  );
}
