/*
 * Minimal offline shell.
 *
 * A volunteer at the river often has no signal at all. The capture page and its
 * assets are cached so the app still opens; the reading itself is queued in
 * IndexedDB by the page and sent when the phone is back online. API calls are
 * never cached — a stale river level would be worse than none. The capture page
 * keeps its own copy of the station list for offline use.
 *
 * Only true static files are cached; Next.js page-data requests (?_rsc=…) go to
 * the network so client-side navigation never shows an old river level.
 */
const CACHE = "bantay-ilog-v2";
const SHELL = ["/", "/capture", "/dashboard", "/manifest.webmanifest", "/icon.svg"];
const STATIC = /^\/(_next\/static\/|samples\/|audio\/|icon(-maskable)?\.svg$|manifest\.webmanifest$)/;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  // Pages: network first, falling back to whatever was cached last.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() =>
          caches.match(request, { ignoreSearch: true }).then((hit) => hit || caches.match("/capture")),
        ),
    );
    return;
  }

  // Static assets: cache first. Everything else (including ?_rsc page data) goes to the network.
  if (!STATIC.test(url.pathname)) return;
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((res) => {
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
          }
          return res;
        }),
    ),
  );
});
