/* Stork Flight offline helper (service worker).
   The first visit saves the game's files; after that it opens even without internet.
   Bump VERSION whenever the game files change, so players get the new version. */
const VERSION = "stork-flight-app-v28";
const CORE = [
  "./", "index.html", "styles.css?v=37", "networks.js?v=37", "game.js?v=37", "online.js?v=37",
  "manifest.webmanifest", "favicon.svg", "favicon-32.png", "apple-touch-icon.png", "icon-192.png", "icon-512.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {   // delete files saved by older versions of THIS app only (the website version shares the address)
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith("stork-flight-app-v") && k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function navigationResponse(req) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(req);
    if (res.ok) {
      try { await cache.put("index.html", res.clone()); } catch (error) { /* Storage may be full. */ }
      return res;
    }
    // A temporary server error must not replace the working offline page.
    return (await cache.match("index.html")) || res;
  } catch (error) {
    const saved = await cache.match("index.html");
    if (saved) return saved;
    throw error;
  }
}

async function assetResponse(req) {
  const cache = await caches.open(VERSION);
  const saved = await cache.match(req);
  if (saved) return saved;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") {
    try { await cache.put(req, res.clone()); } catch (error) { /* Keep the network response if storage is full. */ }
  }
  return res;
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  // the page itself: try the internet first (to get updates), fall back to the saved copy offline
  if (req.mode === "navigate") {
    e.respondWith(navigationResponse(req));
    return;
  }
  // everything else (game files, icons, fonts): use the saved copy, and save anything new
  e.respondWith(assetResponse(req));
});
