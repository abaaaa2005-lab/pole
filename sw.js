// Offline support: the game files and its libraries are cached on install,
// so the app opens without internet (playing together still needs a connection).
const CACHE = 'polevetra-v1';
const LIBS = [
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
  'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/objects/Sky.js',
  'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js'
];
const LOCAL = ['./', 'index.html', 'net.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all([...LOCAL, ...LIBS].map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    // own files: newest from the network, cached copy when offline
    e.respondWith(fetch(req).then(res => {
      const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('index.html'))));
  } else if (LIBS.includes(req.url) || url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    // pinned libraries and fonts never change: cache first
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => {
      const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res;
    })));
  }
  // everything else (the room server) goes straight to the network
});
