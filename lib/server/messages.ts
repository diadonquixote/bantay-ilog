/**
 * Every word residents receive comes from this file.
 *
 * The alert agent decides *whether* and *when* to warn people; it never writes
 * the text. Templates are reviewed once, in Tagalog first then English, so the
 * wording people act on cannot drift under pressure, and nothing a model (or a
 * scraped PAGASA bulletin) produces is ever put in front of a resident.
 */
import { LEVELS, rankOf } from "../levels";
import type { AlertKind, LevelKey, Station } from "../schemas";
import { formatTime } from "./notify";

export interface MessageInput {
  station: Station;
  /** Latest confirmed level, in metres. */
  level: number | null;
  ratePerHour: number | null;
  takenAt: string | null;
  /** Stage the message is about. */
  stage: LevelKey;
  eta?: { key: LevelKey; value: number; minutes: number } | null;
  /** For a provisional warning: the unconfirmed reading that prompted it. */
  pending?: { level: number; stage: LevelKey } | null;
  /** For a de-escalation: the stage residents were last told about. */
  from?: LevelKey | null;
}

const fmt = (m: number | null) => (m == null ? "—" : `${m.toFixed(2)} m`);

function rate(r: number | null): string {
  if (r == null) return "";
  return ` (${r >= 0 ? "+" : ""}${r.toFixed(2)} m/h)`;
}

/** Where to go and who to call — only on messages that ask people to move. */
function footer(st: Station, stage: LevelKey): string {
  const lines: string[] = [];
  if (rankOf(stage) >= 2 && st.evacuationCenter) lines.push(`📍 Evacuation center: ${st.evacuationCenter}`);
  if (st.hotline) lines.push(`☎️ ${st.hotline}`);
  return lines.length ? `\n${lines.join("\n")}` : "";
}

const siren = (stage: LevelKey) => (rankOf(stage) >= 3 ? "🚨🚨" : rankOf(stage) >= 2 ? "🚨" : "⚠️");

export function alertMessage(kind: AlertKind, m: MessageInput): string {
  const st = m.station;
  const title = st.river ? `${st.name} — ${st.river}` : st.name;
  const when = m.takenAt ? formatTime(m.takenAt) : "";
  const now = `${fmt(m.level)}${rate(m.ratePerHour)}${when ? `, ${when}` : ""}`;
  const info = LEVELS[m.stage];

  switch (kind) {
    case "early": {
      const next = m.eta ? LEVELS[m.eta.key] : info;
      const value = m.eta ? `${m.eta.value} m` : "";
      const mins = m.eta ? m.eta.minutes : 0;
      return [
        `⚠️ ${title}`,
        `Tumataas ang ilog: ${now}. Maaaring umabot sa ${next.labelTl} (${value}) sa loob ng ~${mins} minuto. ${next.prepareTl}`,
        "",
        `River rising: ${now}. May reach ${next.label} (${value}) in ~${mins} min. ${next.prepare}`,
      ].join("\n") + footer(st, m.eta?.key ?? m.stage);
    }

    case "provisional": {
      const p = m.pending;
      return [
        `⚠️ ${title}`,
        `May bagong ulat na ${fmt(p?.level ?? null)} na kinukumpirma pa ng tagamasid. Maging handa: ${info.prepareTl}`,
        `Maghihintay ng opisyal na kumpirmasyon bago ang susunod na babala.`,
        "",
        `A new report of ${fmt(p?.level ?? null)} is being checked by an observer. Be ready: ${info.prepare}`,
        `A confirmed alert will follow.`,
      ].join("\n") + footer(st, m.stage);
    }

    case "de-escalation": {
      const was = m.from ? LEVELS[m.from] : info;
      return [
        `🔽 ${title}`,
        `Bumaba ang ilog mula ${was.labelTl} patungong ${info.labelTl}: ${now}.`,
        `Delikado pa rin — huwag munang bumalik sa mababang lugar hangga't walang all-clear.`,
        "",
        `River fell from ${was.label} to ${info.label}: ${now}.`,
        `Still dangerous — do not return to low-lying areas until the all-clear.`,
      ].join("\n") + footer(st, m.stage);
    }

    case "all-clear":
      return [
        `✅ ${title}`,
        `Normal na ang lebel ng ilog: ${now}. Ligtas nang bumalik, pero patuloy na magbantay sa mga anunsyo.`,
        "",
        `River back to normal: ${now}. It is safe to return, but keep listening for announcements.`,
      ].join("\n");

    case "stage":
    default:
      return [
        `${siren(m.stage)} ${title}`,
        `${info.labelTl}: ${now}.`,
        info.actionTl,
        "",
        `${info.label}: ${now}.`,
        info.action,
      ].join("\n") + footer(st, m.stage);
  }
}

/** Safety check before anything leaves the building. */
export function messageFits(text: string): boolean {
  const t = text.trim();
  return t.length >= 20 && t.length <= 900;
}
