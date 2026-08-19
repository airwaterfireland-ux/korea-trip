/* オフライン用サービスワーカー */
const VERSION = 'kt-v18';
const CORE = 'core-' + VERSION;
const DOCS = 'docs-' + VERSION;

const CORE_FILES = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './data/trip.json',
  './data/extras.json',
  './manifest.webmanifest',
  './icon-180.png',
];

const DOC_FILES = [
  './docs/meetpoint-icn-t1-photo.jpg',
  './docs/meetpoint-icn-t1-map.png',
  './docs/luggage-service-ja.pdf',
  './docs/luggage-notes-ja.pdf',
  './docs/luggage-service.pdf',
  './docs/luggage-notes.pdf',
  './docs/skyliner-ticket.png',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const core = await caches.open(CORE);
    await core.addAll(CORE_FILES);
    // PDF は落ちても致命的ではないので個別に、失敗は無視
    const docs = await caches.open(DOCS);
    await Promise.all(DOC_FILES.map(u => docs.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CORE && k !== DOCS).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 別オリジン（GitHub API、地図、Booking など）はそのまま通す
  if (url.origin !== self.location.origin) return;

  // アプリ本体（HTML/CSS/JS/JSON）は常に最新を取りに行く。
  // 取れなければキャッシュを使うのでオフラインでも動く。
  const fresh = req.mode === 'navigate' || /\.(html|json|css|js)$/.test(url.pathname) || url.pathname.endsWith('/');

  if (fresh) {
    // ネットワーク優先（新しい内容を取りに行き、駄目ならキャッシュ）
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        const cache = await caches.open(CORE);
        cache.put(req, res.clone()).catch(() => {});
        return res;
      } catch {
        const hit = await caches.match(req, { ignoreSearch: true });
        return hit || caches.match('./index.html');
      }
    })());
    return;
  }

  // それ以外（CSS/JS/PDF/画像）はキャッシュ優先
  e.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      const cache = await caches.open(url.pathname.includes('/docs/') ? DOCS : CORE);
      cache.put(req, res.clone()).catch(() => {});
      return res;
    } catch {
      return new Response('オフラインです', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
