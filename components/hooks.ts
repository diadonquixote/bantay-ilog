"use client";

import { useSyncExternalStore } from "react";

const noSubscribe = () => () => {};

/**
 * A value that only exists in the browser (localStorage, the URL). The server
 * render and hydration use `serverValue`; the browser value is read right after,
 * with no effect and no extra render pass. `read` must return a primitive.
 */
export function useClientValue<T extends string | number | boolean | null>(read: () => T, serverValue: T): T {
  return useSyncExternalStore(noSubscribe, read, () => serverValue);
}

export function readLocal(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export function writeLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode: nothing remembered, nothing broken
  }
}

function subscribeOnline(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/** navigator.onLine, kept up to date. Assumed online during server render. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
}

interface Clock {
  now: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  subscribe: (onChange: () => void) => () => void;
  read: () => number;
}

const clocks = new Map<number, Clock>();

/** One clock per interval, with stable subscribe/read functions (React re-subscribes if they change). */
function clock(ms: number): Clock {
  const existing = clocks.get(ms);
  if (existing) return existing;
  const created: Clock = {
    now: Date.now(),
    listeners: new Set(),
    timer: null,
    subscribe(onChange) {
      created.listeners.add(onChange);
      if (!created.timer) {
        created.timer = setInterval(() => {
          created.now = Date.now();
          created.listeners.forEach((l) => l());
        }, ms);
      }
      return () => {
        created.listeners.delete(onChange);
        if (created.listeners.size === 0 && created.timer) {
          clearInterval(created.timer);
          created.timer = null;
        }
      };
    },
    read: () => created.now,
  };
  clocks.set(ms, created);
  return created;
}

const serverNow = () => null;

/**
 * The current time, updated every `ms`. One shared timer per interval however
 * many components use it, and it stops when nothing is listening — cheap on
 * low-end phones. Null during server render.
 */
export function useNow(ms: number): number | null {
  const c = clock(ms);
  return useSyncExternalStore(c.subscribe, c.read, serverNow);
}
