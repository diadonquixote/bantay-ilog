"use client";

import { useCallback, useSyncExternalStore } from "react";

const TOKEN_KEY = "bantay-admin-token";
const tokenListeners = new Set<() => void>();

export function getAdminToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

let memoryToken = "";

function readToken(): string {
  return getAdminToken() || memoryToken;
}

function subscribeToken(onChange: () => void) {
  tokenListeners.add(onChange);
  return () => {
    tokenListeners.delete(onChange);
  };
}

const serverToken = () => "";

/** The admin token, shared by every component on the page and remembered on this device. */
export function useAdminToken(): [string, (t: string) => void] {
  const token = useSyncExternalStore(subscribeToken, readToken, serverToken);
  const save = useCallback((t: string) => {
    memoryToken = t;
    try {
      localStorage.setItem(TOKEN_KEY, t);
    } catch {
      // storage unavailable (private mode); token lasts for this page only
    }
    tokenListeners.forEach((l) => l());
  }, []);
  return [token, save];
}

/** fetch + JSON with the admin token header; throws with the server's error message. */
export async function api<T>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = readToken();
  if (token) headers.set("x-admin-token", token);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  const res = await fetch(url, {
    ...init,
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}
