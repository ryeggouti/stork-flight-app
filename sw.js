/* Stork Flight offline helper (service worker).
   The first visit saves the game's files; after that it opens even without internet.
   Bump VERSION whenever the game files change, so players get the new version. */
const VERSION = "stork-flight-app-v18";
const CORE = [
  "./", "index.html", "styles.css?v=28", "networks.js?v=28", "game.js?v=28", "online.js?v=28",
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

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  // the page itself: try the internet first (to get updates), fall back to the saved copy offline
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then(res => {
      const copy = res.clone(); caches.open(VERSION).then(c => c.put("index.html", copy));
      return res;
    }).catch(() => caches.match("index.html")));
    return;
  }
  // everything else (game files, icons, fonts): use the saved copy, and save anything new
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
    if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
    return res;
  })));
});
