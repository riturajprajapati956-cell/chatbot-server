// Orion service worker: shows a friendly page when you are offline.
// Pages are always fetched from the network first, so updates never get stuck.
const CACHE = "orion-offline-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add("/offline.html")));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;   // chat requests go straight to the server
  event.respondWith(fetch(event.request).catch(() => caches.match("/offline.html")));
});
