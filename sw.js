const CACHE_SHELL = 'travel-shelf-shell-v1';
const CACHE_FONTS = 'travel-shelf-fonts-v1';
const DB_NAME = 'TravelBookshelfDB';
const DB_VERSION = 1;
const STORE_NAME = 'books';

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg'
];

// 1. Install: 僅預快取本機外殼，不抓外部字型避免山區弱訊號卡死
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_SHELL)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// 2. Activate: 清除舊版快取並立即接管所有頁面
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_SHELL && key !== CACHE_FONTS)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// 開啟 IndexedDB 讀取指定檔名 HTML
function getBookFromDB(filename) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'filename' });
      }
    };
    req.onsuccess = (e) => {
      const db = e.target.result;
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get(filename);
      getReq.onsuccess = () => resolve(getReq.result || null);
      getReq.onerror = () => reject(getReq.error);
    };
    req.onerror = () => reject(req.error);
  });
}

// 3. Fetch: 虛擬書本路由 -> Google Fonts 懶快取 -> 同源外殼 Cache-First + 背景更新
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const scopeUrl = new URL(self.registration.scope);

  // A. 同源虛擬路由：攔截 ./__book__/<encodeURIComponent(檔名)>
  const bookPrefix = `${scopeUrl.pathname}__book__/`;
  if (url.origin === scopeUrl.origin && url.pathname.startsWith(bookPrefix)) {
    const encodedName = url.pathname.slice(bookPrefix.length);
    const filename = decodeURIComponent(encodedName);

    event.respondWith(
      getBookFromDB(filename)
        .then((record) => {
          if (!record || typeof record.html !== 'string') {
            return new Response(
              `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:2rem;background:#FFFCF6;color:#4E3A39;"><h2>找不到手冊檔案</h2><p>「${filename}」可能已被移除，請返回書架重新匯入。</p></body>`,
              {
                status: 404,
                headers: {
                  'Content-Type': 'text/html; charset=utf-8',
                  'Cache-Control': 'no-store'
                }
              }
            );
          }
          return new Response(record.html, {
            status: 200,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store'
            }
          });
        })
        .catch(() => {
          return new Response('IndexedDB 讀取失敗', {
            status: 500,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        })
    );
    return;
  }

  // B. Google Fonts 懶快取 (允許 ok 或 opaque 回應)
  if (
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com'
  ) {
    event.respondWith(
      caches.open(CACHE_FONTS).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        try {
          const networkResp = await fetch(request);
          if (networkResp && (networkResp.ok || networkResp.type === 'opaque')) {
            cache.put(request, networkResp.clone());
          }
          return networkResp;
        } catch {
          return new Response('', { status: 408 });
        }
      })
    );
    return;
  }

  // C. 同源外殼靜態資源：Cache-First + 背景更新 (Stale-While-Revalidate)
  if (url.origin === scopeUrl.origin) {
    event.respondWith(
      caches.open(CACHE_SHELL).then(async (cache) => {
        const cached = await cache.match(request, { ignoreSearch: true });
        const fetchPromise = fetch(request)
          .then((networkResp) => {
            if (networkResp && networkResp.ok) {
              cache.put(request, networkResp.clone());
            }
            return networkResp;
          })
          .catch(() => null);

        return cached || (await fetchPromise) || new Response('離線中', { status: 503 });
      })
    );
  }
});