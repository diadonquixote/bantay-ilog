/**
 * Readings taken where the signal is weak are kept in IndexedDB and re-sent
 * when the phone is back online. Each item carries a clientId, so the server
 * ignores a re-send it has already stored.
 */

export interface QueuedItem {
  clientId: string;
  endpoint: string;
  payload: Record<string, unknown>;
  createdAt: string;
  attempts: number;
  lastError: string | null;
}

const DB_NAME = "bantay-ilog";
const STORE = "outbox";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "clientId" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => {
      db.close();
      resolve(req.result);
    };
    t.onerror = () => {
      db.close();
      reject(t.error);
    };
  });
}

export const listQueued = () => tx<QueuedItem[]>("readonly", (s) => s.getAll() as IDBRequest<QueuedItem[]>);
const put = (item: QueuedItem) => tx("readwrite", (s) => s.put(item));
const remove = (clientId: string) => tx("readwrite", (s) => s.delete(clientId));

export function newClientId(): string {
  return crypto.randomUUID();
}

export type SubmitResult =
  | { status: "sent"; data: unknown }
  | { status: "queued"; reason: string }
  | { status: "rejected"; error: string };

async function post(endpoint: string, payload: unknown): Promise<Response> {
  return fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

const retryable = (status: number) => status >= 500 || status === 408 || status === 429;

/** Try to send now; if offline or the server is unreachable, queue it. */
export async function submitOrQueue(endpoint: string, payload: Record<string, unknown> & { clientId: string }): Promise<SubmitResult> {
  const queue = async (reason: string): Promise<SubmitResult> => {
    await put({ clientId: payload.clientId, endpoint, payload, createdAt: new Date().toISOString(), attempts: 0, lastError: reason });
    return { status: "queued", reason };
  };
  if (typeof navigator !== "undefined" && !navigator.onLine) return queue("offline");
  try {
    const res = await post(endpoint, payload);
    const data = await res.json().catch(() => ({}));
    if (res.ok) return { status: "sent", data };
    if (retryable(res.status)) return queue(`server error ${res.status}`);
    return { status: "rejected", error: (data as { error?: string }).error ?? `HTTP ${res.status}` };
  } catch (e) {
    return queue((e as Error).message || "network error");
  }
}

/** Re-send everything queued. Items the server rejects outright (4xx) are dropped and reported. */
export async function flushQueue(): Promise<{ sent: number; kept: number; dropped: { clientId: string; error: string }[] }> {
  const items = await listQueued();
  let sent = 0;
  let kept = 0;
  const dropped: { clientId: string; error: string }[] = [];
  for (const item of items) {
    try {
      const res = await post(item.endpoint, item.payload);
      if (res.ok) {
        await remove(item.clientId);
        sent++;
      } else if (retryable(res.status)) {
        await put({ ...item, attempts: item.attempts + 1, lastError: `HTTP ${res.status}` });
        kept++;
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        await remove(item.clientId);
        dropped.push({ clientId: item.clientId, error: body.error ?? `HTTP ${res.status}` });
      }
    } catch (e) {
      await put({ ...item, attempts: item.attempts + 1, lastError: (e as Error).message });
      kept++;
      break; // still offline; stop hammering
    }
  }
  return { sent, kept, dropped };
}
