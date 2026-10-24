/* SAFI TV+ — offline app shell cache (v1.7.1)
   Caches ONLY the app interface so SAFI TV+ opens with no internet.
   Live streams/videos are NOT cached here (they need internet, or use
   Downloads/Recordings/USB in the Offline page). */
const CACHE = "safi-ui-v2.0.0";
const ASSETS = ["./", "./index.html", "./css/tv.css", "./js/data.js", "./js/app.js", "./js/world-data.js", "./assets/hero-kenya.jpg", "./assets/hero-movie.jpg", "./assets/hero-kids.jpg", "./assets/hero-sports.jpg", "./assets/hero-news.jpg", "./assets/hero-novela.jpg", "./assets/hero-music.jpg", "./assets/hero-travel.jpg", "./assets/hero-nature.jpg", "./js/hls.min.js"];

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.allSettled(ASSETS.map(u => c.add(u)));
    self.skipWaiting();
  })());
});
self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // Never touch live streams / media / other sites — network only, as normal.
  if (url.origin !== self.location.origin) return;
  if (/\.(m3u8|ts|m4s|mp4|webm)$/i.test(url.pathname)) return;
  // App code: network-first (prevents a stale cached build from getting stuck),
  // with cache fallback so the shell still opens fully offline.
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    try {
      const r = await fetch(e.request, { cache: "no-cache" });
      if (r && r.ok) c.put(e.request, r.clone());
      return r;
    } catch (_) {
      const hit = await c.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      throw _;
    }
  })());
});
