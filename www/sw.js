// Offline support. The pose model and MediaPipe runtime (lib/, ~15 MB) are cached the first time they
// are used, so after one analysis the app works without a connection. Everything else tries the
// network first, so a new version shows up as soon as you are online.
const CACHE = 'swingcoach-v1';
const CORE = [
  './', 'index.html', 'app.css', 'app.js', 'manifest.webmanifest',
  'engine/swing.js', 'engine/coach.js', 'engine/arousal.js', 'engine/calm.js', 'engine/demo.js',
  'engine/hr-sources.js', 'engine/insights.js', 'engine/pose.js',
  'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  const isLib = url.pathname.includes('/lib/');
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (isLib) {                                         // big and never changes: cache first
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    }
    try {                                                // app files: network first, cache as fallback
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
