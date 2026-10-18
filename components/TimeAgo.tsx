"use client";

import { useNow } from "./hooks";

const abs = (iso: string) =>
  new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));

export function ago(iso: string, now = Date.now()): string {
  const min = Math.round((now - Date.parse(iso)) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${min % 60 ? `${min % 60} min ` : ""}ago`;
  return abs(iso);
}

/**
 * "12 min ago", with the exact Manila time on hover. Server-rendered as the
 * absolute time, then switched to relative after hydration and kept fresh.
 */
export function TimeAgo({ iso, staleAfterMin }: { iso: string; staleAfterMin?: number }) {
  const now = useNow(30_000);
  const stale = now != null && staleAfterMin != null && now - Date.parse(iso) > staleAfterMin * 60_000;
  return (
    <time dateTime={iso} title={abs(iso)} className={stale ? "stale" : undefined}>
      {now == null ? abs(iso) : ago(iso, now)}
    </time>
  );
}

export { abs as formatManila };
