"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useClientValue } from "./hooks";

interface NetworkInformation {
  saveData?: boolean;
  effectiveType?: string;
}

/**
 * Prefetching every page in the menu is free on Wi-Fi but costs a volunteer on
 * a slow or metered phone data they need. Only prefetch on a fast connection
 * with data saver off.
 */
function usePrefetchOk(): boolean {
  return useClientValue(() => {
    const c = (navigator as Navigator & { connection?: NetworkInformation }).connection;
    if (!c) return true;
    return !c.saveData && (c.effectiveType === undefined || c.effectiveType === "4g");
  }, false);
}

const ICONS = {
  status: (
    <path d="M3 17c2 0 2-1.5 4.5-1.5S10 17 12 17s2-1.5 4.5-1.5S19 17 21 17M3 12c2 0 2-1.5 4.5-1.5S10 12 12 12s2-1.5 4.5-1.5S19 12 21 12M12 3v5" />
  ),
  capture: (
    <>
      <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  dashboard: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  setup: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" />
    </>
  ),
};

const LINKS = [
  { href: "/", label: "River status", short: "Status", icon: ICONS.status },
  { href: "/capture", label: "Take a reading", short: "Capture", icon: ICONS.capture },
  { href: "/dashboard", label: "Dashboard", short: "Dashboard", icon: ICONS.dashboard },
  { href: "/setup", label: "Setup", short: "Setup", icon: ICONS.setup },
];

function isActive(path: string, href: string) {
  return href === "/" ? path === "/" : path.startsWith(href);
}

export function TopNav() {
  const path = usePathname();
  const prefetch = usePrefetchOk();
  return (
    <ul className="top-links">
      {LINKS.map((l) => (
        <li key={l.href}>
          <Link href={l.href} prefetch={prefetch ? undefined : false} aria-current={isActive(path, l.href) ? "page" : undefined}>
            {l.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Phone tab bar: the four places a volunteer or resident goes, under the thumb. */
export function BottomNav() {
  const path = usePathname();
  const prefetch = usePrefetchOk();
  return (
    <nav className="bottom-nav" aria-label="Main">
      {LINKS.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          prefetch={prefetch ? undefined : false}
          aria-current={isActive(path, l.href) ? "page" : undefined}
        >
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            {l.icon}
          </svg>
          <span>{l.short}</span>
        </Link>
      ))}
    </nav>
  );
}
