/* Boonbeat offline shell: the app's own files are cached so it opens instantly and installs as an app.
   Always tries the network first, so updates show up on the next open. Music is never cached here. */
const CACHE = 'boonbeat-v5';
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;   // songs and APIs go straight to the network
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: false }).then(r => r || caches.match(e.request, { ignoreSearch: true }))));
});
