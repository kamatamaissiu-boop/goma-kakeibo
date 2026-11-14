// ごまちゃん家計簿 Service Worker
//
// 方針
//  - アプリの殻(HTML / CSS / JS / アイコン)を端末に保存する。
//  - ページを開く通信(ナビゲーション)は「まずネット、だめなら保存分」。
//    → 公開した更新がすぐ反映されやすい。電波がなくても開ける。
//  - CSS / JS / アイコンは「保存分をすぐ返し、裏で新しいものに入れ替える」。
//  - ごまちゃんの絵(img/ の PNG)は、殻とは別の入れ物に保存する。
//      ・殻のインストールには含めない(絵が取れなくても、インストールは失敗しない。初回の表示も待たせない)。
//      ・殻が動きだしたあと、画面からの合図で、裏でまとめて保存する。合図の前に画面に出た絵も、その場で保存する。
//      ・保存してあれば、通信せずにそれを返す(絵は版が上がっても使い回す)。
//        絵のファイルを差し替えたときは、ART_CACHE の番号を上げる(古い絵が消えて、取り直される)。
//  - アルバムの写真は、ここでは扱わない(画面の側が IndexedDB に保存する。js/photos.js)。
//    殻とも絵とも別の場所なので、版が上がっても・絵を差し替えても、消えない。
//  - 保存先(Google Apps Script)との通信は一切さわらない・保存しない。
//
// 画面のファイルを直したら APP_VERSION を上げる(古い保存分が消えて入れ替わる)。

const APP_VERSION = "0.6.1";
const SHELL_CACHE = `goma-kakeibo-shell-v${APP_VERSION}`;
const SHELL_PREFIX = "goma-kakeibo-shell-";
const FONT_CACHE = "goma-kakeibo-fonts-v1"; // フォントは版が変わっても使い回す
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];
const ART_CACHE = "goma-kakeibo-art-v1"; // ごまちゃんの絵。差し替えたら番号を上げる
const ART_PREFIX = "goma-kakeibo-art-";
const ART_DIR = "img/";
const NAVIGATION_TIMEOUT_MS = 4000;

// 先に保存しておくファイル(すべて相対パス。サブパス配信でも動く)
const SHELL_FILES = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "css/app.css",
  "js/app.js",
  "js/api.js",
  "js/config.js",
  "js/store.js",
  "js/util.js",
  "js/queue.js",
  "js/input.js",
  "js/summary.js",
  "js/view.js",
  "js/monthly.js",
  "js/photos.js",
  "js/album.js",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
];

// ごまちゃんの絵(裏でまとめて保存する。よく出る順)
const ART_FILES = [
  "img/goma-face.png",
  "img/goma-peek.png",
  "img/goma-reach.png",
  "img/goma-loaf.png",
  "img/goma-jito.png",
  "img/goma-sleep.png",
  "img/goma-back.png",
  "img/goma-hesoten.png",
  "img/goma-cover.png",
];
const ART_BASE = new URL(ART_DIR, self.location.href).href;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // cache: "reload" … ブラウザの古い HTTP キャッシュを使わず、必ず取り直す
      await cache.addAll(SHELL_FILES.map((path) => new Request(path, { cache: "reload" })));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(
            (name) =>
              (name.startsWith(SHELL_PREFIX) && name !== SHELL_CACHE) || (name.startsWith(ART_PREFIX) && name !== ART_CACHE)
          )
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

// 画面からの合図: ごまちゃんの絵を、裏でまとめて保存する
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "cache-art") {
    event.waitUntil(cacheArt());
  }
});

/** まだ保存していない絵を、1枚ずつ取って保存する。取れなかった絵は、とばす(次に画面に出たときに保存される) */
async function cacheArt() {
  const cache = await caches.open(ART_CACHE);
  for (const path of ART_FILES) {
    try {
      if (await cache.match(path)) continue;
      const response = await fetch(path);
      if (response.ok) await cache.put(path, response);
    } catch {
      /* 電波がない等。あとで画面に出たときに保存される */
    }
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  // POST(= 保存先への通信)は何もしない
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    if (request.mode === "navigate") {
      event.respondWith(networkFirst(request));
    } else if (url.href.startsWith(ART_BASE)) {
      event.respondWith(cacheFirst(request, ART_CACHE));
    } else {
      event.respondWith(staleWhileRevalidate(event, request, SHELL_CACHE));
    }
    return;
  }

  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(event, request, FONT_CACHE));
  }
  // それ以外の外部への通信(Google Apps Script など)は、ブラウザにそのまま任せる
});

/** まずネット。時間切れ・失敗なら保存分(なければ index.html)を返す */
async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetchWithTimeout(request, NAVIGATION_TIMEOUT_MS);
    if (response.ok) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached =
      (await cache.match(request, { ignoreSearch: true })) ||
      (await cache.match("index.html")) ||
      (await cache.match("./"));
    if (cached) return cached;
    return new Response("電波がないみたいにゃ。つながるところで、もういちど開いてね。", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}

/** 保存分があれば、通信せずにそれを返す。なければ取ってきて、保存する(ごまちゃんの絵) */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    return Response.error();
  }
}

/** 保存分があればすぐ返し、裏で取り直して次回に備える */
async function staleWhileRevalidate(event, request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const refresh = fetch(request)
    .then(async (response) => {
      // opaque … 外部の CSS(フォント)を <link> で読んだときの、中身の見えない応答
      if (response.ok || response.type === "opaque") {
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(refresh);
    return cached;
  }
  const fresh = await refresh;
  return fresh || Response.error();
}

function fetchWithTimeout(request, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    fetch(request).then(
      (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
