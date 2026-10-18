import type { LevelKey, Station, Thresholds } from "./schemas";

export interface LevelInfo {
  key: LevelKey;
  rank: number;
  label: string;
  /** Tagalog label shown alongside English in alerts and the UI. */
  labelTl: string;
  action: string;
  actionTl: string;
  /** What to do when this stage is expected soon (early warnings). */
  prepare: string;
  prepareTl: string;
  color: string;
}

export const LEVELS: Record<LevelKey, LevelInfo> = {
  normal: {
    key: "normal",
    rank: 0,
    label: "Normal",
    labelTl: "Normal",
    action: "No action needed. Keep monitoring.",
    actionTl: "Walang kailangang gawin. Patuloy na magbantay.",
    prepare: "Keep monitoring.",
    prepareTl: "Patuloy na magbantay.",
    color: "#2f9e44",
  },
  alert: {
    key: "alert",
    rank: 1,
    label: "1st Alarm — Alert",
    labelTl: "Unang Alarma — Maging Alerto",
    action: "Be alert. Monitor the river and announcements.",
    actionTl: "Maging alerto. Bantayan ang ilog at mga anunsyo.",
    prepare: "Watch the river and listen for announcements.",
    prepareTl: "Bantayan ang ilog at makinig sa mga anunsyo.",
    color: "#e8b100",
  },
  alarm: {
    key: "alarm",
    rank: 2,
    label: "2nd Alarm — Prepare to evacuate",
    labelTl: "Ikalawang Alarma — Maghanda sa paglikas",
    action: "Prepare to evacuate. Secure documents, medicine, go-bags.",
    actionTl: "Maghanda sa paglikas. Ihanda ang mga dokumento, gamot at go-bag.",
    prepare: "Get your go-bag, documents and medicine ready.",
    prepareTl: "Ihanda na ang go-bag, mga dokumento at gamot.",
    color: "#f76707",
  },
  critical: {
    key: "critical",
    rank: 3,
    label: "3rd Alarm — Evacuate now",
    labelTl: "Ikatlong Alarma — Lumikas na",
    action: "Evacuate now to the designated evacuation center.",
    actionTl: "Lumikas na ngayon sa itinalagang evacuation center.",
    prepare: "Be ready to evacuate. Move children, elderly and sick people early.",
    prepareTl: "Maging handang lumikas. Unahing ilikas ang mga bata, matatanda at may sakit.",
    color: "#e03131",
  },
};

export function classify(level: number, t: Thresholds): LevelKey {
  if (level >= t.critical) return "critical";
  if (level >= t.alarm) return "alarm";
  if (level >= t.alert) return "alert";
  return "normal";
}

export function rankOf(key: LevelKey): number {
  return LEVELS[key].rank;
}

/** The next threshold above `level`, or null if already critical. */
export function nextThreshold(level: number, t: Thresholds): { key: LevelKey; value: number } | null {
  if (level < t.alert) return { key: "alert", value: t.alert };
  if (level < t.alarm) return { key: "alarm", value: t.alarm };
  if (level < t.critical) return { key: "critical", value: t.critical };
  return null;
}

/** How often observers should take a reading at each stage (minutes). */
export const READING_CADENCE_MIN: Record<LevelKey, number | null> = {
  normal: null,
  alert: 60,
  alarm: 30,
  critical: 15,
};

/** How far below a threshold the river must fall before an all-clear goes out. */
export const ALL_CLEAR_MARGIN_M = 0.1;

export function formatLevel(m: number | null | undefined): string {
  return m == null ? "—" : `${m.toFixed(2)} m`;
}

export const DEFAULT_STATION: Station = {
  id: "sto-nino",
  name: "Sto. Niño Gauge",
  river: "Marikina River",
  location: "Sto. Niño bridge, Marikina City",
  gaugeMin: 10,
  gaugeMax: 22,
  thresholds: { alert: 15, alarm: 16, critical: 17 },
  tolerance: 0.1,
  maxRatePerHour: 2,
  evacuationCenter: "",
  hotline: "",
  teamChatIds: [],
};

export const DEMO_STATION: Station = {
  id: "demo",
  name: "Demo Gauge",
  river: "Demo River",
  location: "Simulated station for the /demo page",
  gaugeMin: 0,
  gaugeMax: 6,
  thresholds: { alert: 3, alarm: 4, critical: 5 },
  tolerance: 0.1,
  maxRatePerHour: 2,
  evacuationCenter: "Demo Elementary School",
  hotline: "0999-000-0000",
  // Stand-in chat: messages to "demo-*" ids go to the outbox only, never to Telegram.
  teamChatIds: ["demo-team"],
};
