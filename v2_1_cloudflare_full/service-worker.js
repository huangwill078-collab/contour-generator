const CACHE_NAME = "contour-generator-v6-5";
const APP_SHELL = [
  "./",
  "./assets/app.css",
  "./assets/app.js",
  "./assets/lucide.min.js",
  "./icons/app-icon-master.png",
  "./icons/apple-touch-icon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/map-generator-192.png",
  "./icons/map-generator-512.png",
  "./icons/map-generator-maskable.png",
  "./icons/map-generator-touch.png",
  "./icons/maskable-512.png",
  "./index.html",
  "./manifest.webmanifest"
];
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET" || new URL(event.request.url).pathname.startsWith("/api/")) return;
  event.respondWith(fetch(event.request, { cache: "reload" }).then(response => {
    if (response.ok && response.type === "basic") caches.open(CACHE_NAME).then(cache => cache.put(event.request, response.clone()));
    return response;
  }).catch(() => caches.match(event.request).then(cached => cached || caches.match("./index.html"))));
});
