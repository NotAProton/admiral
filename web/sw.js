self.addEventListener("install", (event) => {
  event.waitUntil(caches.open("admiral-shell-v1").then((cache) => cache.addAll(["/", "/app.js", "/today", "/today.js", "/participant-stats", "/participant-stats.js", "/manifest.json"])).catch(() => undefined));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !["/", "/app.js", "/today", "/today.js", "/participant-stats", "/participant-stats.js", "/manifest.json"].includes(url.pathname)) return;
  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok) caches.open("admiral-shell-v1").then((cache) => cache.put(event.request, response.clone())).catch(() => undefined);
    return response;
  }).catch(() => caches.match(event.request)));
});
