// アルバムの写真(仕様書 4.4)の、データの係。画面は album.js、写真の枠(入力・見る・毎月の設定)は createSlot。
//
// どこに何を置くか
//   - 写真の一覧({id, 足した人, 追加日時})… localStorage(store.js)。保存先から sync のたびに届く。
//   - 写真の中身(JPEG)                  … この端末の IndexedDB「goma-kakeibo-photos」。
//       大きいので localStorage には置かない。アプリの殻やごまちゃんの絵(Service Worker のキャッシュ)とも別なので、
//       版が上がっても消えない。一度取った写真は、2回目からは通信なしで出る。
//       一覧から消えた写真(相手が外した等)は、端末からも消す。
//   - これから送る写真(足したばかり)    … 同じ IndexedDB の「uploads」に印を置く。送れたら印を消す。
//       送れなかった写真は端末に残り、次の合図(起動・電波が戻った・画面に戻った・30秒後・「もういちど送る」)で送り直す。
//   - まだ送れていない「外す」           … localStorage(store.js)。
//
// 送り方
//   - 写真は1枚ずつ、足した順に送る。保存先は同じ id を二重に置かないので、何度送り直しても二重にならない。
//   - 足した本人の画面には、送り終わるのを待たずに出す(端末に保存した時点で、一覧に入る)。
//   - 保存先(GAS)が古い版(unknown_action)のあいだは、写真を端末に残したまま、待つ。
//
// 取り方
//   - 中身は、必要になったときに1枚ずつ取る(アルバムを開いた・ランダムで選ばれた)。

import { ApiError, addPhoto, getPhoto, removePhoto } from "./api.js";
import { PHOTO_MAX_SIDE, PHOTO_QUALITY, PHOTO_TARGET_BYTES } from "./config.js";
import * as store from "./store.js";
import { newId } from "./util.js";

const DB_NAME = "goma-kakeibo-photos";
const DB_VERSION = 1;
const STORE_BLOBS = "blobs";     // id → 写真の中身(ArrayBuffer。JPEG)
const STORE_UPLOADS = "uploads"; // { id, user, createdAt, tried } … これから送る写真

const RETRY_MS = 30000;
/** 同じ写真の取得に失敗したあと、次に試すまでの間隔(アルバムを開いたときは、すぐ試す) */
const FETCH_COOLDOWN_MS = 60000;
/** いちどに取りに行く写真の数 */
const FETCH_PARALLEL = 3;
/** 送ったばかり・外したばかりの写真を、行きちがいで届いた古い一覧から守る時間 */
const RECENT_MS = 90000;
/** 目安の大きさに収まらなかったときに、順に試す(長辺, 品質)。最後のものは、大きさにかかわらず使う */
const SHRINK_STEPS = Object.freeze([
  [PHOTO_MAX_SIDE, PHOTO_QUALITY],
  [PHOTO_MAX_SIDE, 0.7],
  [PHOTO_MAX_SIDE, 0.6],
  [1000, 0.6],
  [800, 0.55],
]);

// --- 端末の保存場所(IndexedDB) ---------------------------------------------

/** IndexedDB が使えないとき(プライベートブラウズなど)の代わり。開いているあいだだけ覚えている */
const memory = { blobs: new Map(), uploads: new Map() };
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let request;
    try {
      request = window.indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_BLOBS)) db.createObjectStore(STORE_BLOBS);
      if (!db.objectStoreNames.contains(STORE_UPLOADS)) db.createObjectStore(STORE_UPLOADS, { keyPath: "id" });
    };
    request.onsuccess = () => {
      const db = request.result;
      // ほかのタブが新しい版で開こうとしたら、ゆずる
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

/** IndexedDB の操作を1つ行う。使えないときは fallback の結果を返す */
async function withStore(name, mode, work, fallback) {
  const db = await openDb();
  if (!db) return fallback();
  return new Promise((resolve, reject) => {
    let result;
    let tx;
    try {
      tx = db.transaction(name, mode);
      const request = work(tx.objectStore(name));
      if (request) {
        request.onsuccess = () => {
          result = request.result;
        };
      }
    } catch (err) {
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const db = {
  blobKeys: () => withStore(STORE_BLOBS, "readonly", (s) => s.getAllKeys(), () => Array.from(memory.blobs.keys())),
  getBlob: (id) => withStore(STORE_BLOBS, "readonly", (s) => s.get(id), () => memory.blobs.get(id)),
  putBlob: (id, data) => withStore(STORE_BLOBS, "readwrite", (s) => s.put(data, id), () => void memory.blobs.set(id, data)),
  deleteBlob: (id) => withStore(STORE_BLOBS, "readwrite", (s) => s.delete(id), () => void memory.blobs.delete(id)),
  allUploads: () => withStore(STORE_UPLOADS, "readonly", (s) => s.getAll(), () => Array.from(memory.uploads.values())),
  putUpload: (meta) => withStore(STORE_UPLOADS, "readwrite", (s) => s.put(meta), () => void memory.uploads.set(meta.id, meta)),
  deleteUpload: (id) => withStore(STORE_UPLOADS, "readwrite", (s) => s.delete(id), () => void memory.uploads.delete(id)),
};

// --- いまの状態(端末の保存場所の写し) ---------------------------------------

/** 中身が端末にある写真の id */
const localIds = new Set();
/** これから送る写真(id → { id, user, createdAt, tried }) */
const uploads = new Map();
/** 送る写真のようす(id → "sending" | "failed")。無ければ「順番待ち」 */
const uploadState = new Map();
/** 画面に出すための URL(id → blob: の URL)。一度作ったら使い回す */
const urls = new Map();
/** 取りに行っている最中の写真(id → Promise) */
const fetching = new Map();
/** 取得に失敗した時刻(id → ミリ秒) */
const fetchFailedAt = new Map();
/** 送り終えた時刻・外した時刻(id → ミリ秒)。行きちがいの一覧から守るため */
const uploadedAt = new Map();
const removedAt = new Map();

const listeners = new Set();
let running = null;
let retryTimer = 0;
let updateNeeded = false; // 保存先が古い版で、写真を受けつけてもらえなかった
let ready = null;

/** 端末の保存場所を読んで、使えるようにする(何度呼んでもよい) */
export function initPhotos() {
  if (!ready) {
    ready = (async () => {
      try {
        const [keys, metas] = await Promise.all([db.blobKeys(), db.allUploads()]);
        for (const key of keys) localIds.add(String(key));
        for (const meta of metas) {
          // 中身が無い印(保存の途中で閉じられた等)は、捨てる
          if (meta && meta.id && localIds.has(meta.id)) uploads.set(meta.id, meta);
          else if (meta && meta.id) db.deleteUpload(meta.id).catch(() => {});
        }
      } catch (err) {
        console.warn("写真の保存場所を読めませんでした", err);
      }
    })();
  }
  return ready;
}

/**
 * 写真のようすの変化を受け取る。
 * @param {(event: {type: string, code?: string, id?: string, reason?: string}) => void} fn
 *   type: "change"(一覧・中身・送信のようすが変わった) / "sent"(1枚送れた) / "error"(送れずに中断) / "dropped"(受けつけてもらえず、外した)
 */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(event) {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch (err) {
      console.error(err);
    }
  }
}

function myUploads() {
  const user = store.getUser();
  return Array.from(uploads.values())
    .filter((meta) => meta.user === user)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function myRemovals() {
  const user = store.getUser();
  return store.getPhotoRemovals().filter((r) => r.user === user);
}

/** 外そうとしている写真の id(まだ送れていない分。だれが外したものでも、この端末では出さない) */
function removingIds() {
  return new Set(store.getPhotoRemovals().map((r) => r.id));
}

/**
 * アルバムに出す写真の一覧(新しい順)。まだ送れていない自分の写真が先頭。
 * @returns {{id: string, state: "saved" | "waiting" | "sending" | "failed", local: boolean}[]}
 *   local = 中身が端末にあるか(無ければ、これから取る)
 */
export function listPhotos() {
  const removing = removingIds();
  const result = [];
  const seen = new Set();
  for (const meta of myUploads().reverse()) {
    seen.add(meta.id);
    result.push({ id: meta.id, state: uploadState.get(meta.id) || "waiting", local: true });
  }
  // 保存先の一覧は、足した順(古い順)に並んでいる。うしろから出せば、新しい順になる
  const saved = store
    .getPhotos()
    .filter((p) => !seen.has(p.id) && !removing.has(p.id))
    .reverse();
  for (const p of saved) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    result.push({ id: p.id, state: "saved", local: localIds.has(p.id) });
  }
  return result;
}

/** まだ送れていない写真と「外す」の数(自分の分) */
export function pendingCount() {
  return myUploads().length + myRemovals().length;
}

/** 送れずに残っている写真の数(自分の分) */
export function failedCount() {
  return myUploads().filter((meta) => uploadState.get(meta.id) === "failed").length;
}

/** 保存先が古い版のために、送れずに待っているものがあるか */
export function needsUpdate() {
  return updateNeeded && pendingCount() > 0;
}

/** 写真の、画面に出すための URL。中身が端末に無ければ null */
export async function getUrl(id) {
  await initPhotos();
  if (urls.has(id)) return urls.get(id);
  if (!localIds.has(id)) return null;
  let data;
  try {
    data = await db.getBlob(id);
  } catch {
    data = null;
  }
  if (!data) {
    localIds.delete(id);
    return null;
  }
  if (urls.has(id)) return urls.get(id);
  const url = URL.createObjectURL(new Blob([data], { type: "image/jpeg" }));
  urls.set(id, url);
  return url;
}

/** 端末から、写真の中身を消す */
async function forget(id) {
  localIds.delete(id);
  const url = urls.get(id);
  if (url) {
    urls.delete(id);
    // いま画面に出ている絵が消えないように、少しあとで片づける
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  try {
    await db.deleteBlob(id);
  } catch {
    /* 消せなくても、一覧に無いので出ない */
  }
}

// --- 縮小(仕様書 4.4: 長辺 1,200px ほどの JPEG にしてから送る) ----------------

function isJpeg(buffer) {
  const head = new Uint8Array(buffer, 0, Math.min(3, buffer.byteLength));
  return head.length === 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("decode"));
    img.src = url;
  });
}

function canvasToJpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("encode"))), "image/jpeg", quality);
  });
}

/**
 * 端末の写真を、送るための JPEG にする。
 *   - <img> で読むので、写真の向き(EXIF)は、ブラウザが正しく直したものになる。
 *   - iPhone の HEIC は、Safari が写真をえらぶときに JPEG にして渡してくれる。
 *     ブラウザが読めない形式(パソコンで HEIC をえらんだ等)は、Error("decode") になる。
 * @param {Blob} file
 * @returns {Promise<{data: ArrayBuffer, width: number, height: number}>}
 */
export async function prepareImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) throw new Error("decode");
    let last = null;
    for (const [side, quality] of SHRINK_STEPS) {
      const scale = Math.min(1, side / Math.max(w, h));
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement("canvas");
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("encode");
      // すきとおった部分(PNG など)は、白にする
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, cw, ch);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, cw, ch);
      const blob = await canvasToJpeg(canvas, quality);
      // 使い終わった canvas のメモリを、早めに返す(iPhone は canvas の合計に上限がある)
      canvas.width = 0;
      canvas.height = 0;
      last = { blob, width: cw, height: ch };
      if (blob.size <= PHOTO_TARGET_BYTES) break;
    }
    const data = await new Response(last.blob).arrayBuffer();
    if (!isJpeg(data)) throw new Error("encode");
    return { data, width: last.width, height: last.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return window.btoa(text);
}

function fromBase64(text) {
  const binary = window.atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// --- 足す・外す ---------------------------------------------------------------

/**
 * 端末でえらんだ写真を、アルバムに足す。1枚ずつ縮小して端末に保存し、その場で一覧に出して、裏で順に送る。
 * @param {File[]} files
 * @param {(done: number, total: number) => void} [onProgress] 1枚の準備が終わるたびに呼ぶ
 * @returns {Promise<{added: number, unreadable: number, failed: number}>}
 *   unreadable = ブラウザが読めない形式で、とばした数 / failed = 端末に保存できなかった数
 */
export async function addFiles(files, onProgress) {
  await initPhotos();
  const user = store.getUser();
  const result = { added: 0, unreadable: 0, failed: 0 };
  let done = 0;
  for (const file of files) {
    try {
      const { data } = await prepareImage(file);
      const meta = { id: newId(), user, createdAt: Date.now() + result.added / 1000, tried: false };
      await db.putBlob(meta.id, data);
      localIds.add(meta.id);
      await db.putUpload(meta);
      uploads.set(meta.id, meta);
      result.added += 1;
      emit({ type: "change" });
      flush(); // 1枚目から送りはじめる(残りの準備と並行して進む)
    } catch (err) {
      if (err && (err.message === "decode" || err.message === "encode")) result.unreadable += 1;
      else result.failed += 1;
    }
    done += 1;
    if (onProgress) onProgress(done, files.length);
  }
  return result;
}

/**
 * 写真をアルバムから外す。画面からはすぐ消し、保存先へは裏で送る。
 *   - まだ一度も送っていない写真 → 端末から消すだけ(通信なし)
 *   - それ以外 → 「外す」を積んで送る(保存先に無ければ何も起きない)
 */
export async function removePhotoById(id) {
  await initPhotos();
  const meta = uploads.get(id);
  const wasTried = meta ? Boolean(meta.tried) : true;
  if (meta) {
    uploads.delete(id);
    uploadState.delete(id);
    try {
      await db.deleteUpload(id);
    } catch {
      /* 印が残っても、中身を消すので、次に開いたときに捨てられる */
    }
  }
  if (wasTried) {
    const removals = store.getPhotoRemovals().filter((r) => r.id !== id);
    removals.push({ id, user: store.getUser() });
    store.setPhotoRemovals(removals);
    removedAt.set(id, Date.now());
  }
  store.setPhotos(store.getPhotos().filter((p) => p.id !== id));
  await forget(id);
  emit({ type: "change" });
  if (wasTried) flush();
}

// --- 送る ---------------------------------------------------------------------

/** たまっている写真と「外す」を送る。すでに送信中なら、その続きを待つ */
export function flush() {
  if (!running) {
    running = run()
      .catch((err) => console.error(err))
      .finally(() => {
        running = null;
      });
  }
  return running;
}

/** 「もういちど送る」: 送れなかった写真を、順番待ちに戻して送る */
export function retry() {
  for (const [id, state] of uploadState) {
    if (state === "failed") uploadState.delete(id);
  }
  updateNeeded = false;
  emit({ type: "change" });
  return flush();
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    if (document.visibilityState === "visible") flush();
  }, RETRY_MS);
}

/** 送れなかった: 残りの写真に「送れていません」の印を付けて、中断する */
function stopWith(code) {
  for (const meta of myUploads()) uploadState.set(meta.id, "failed");
  if (code === "unknown_action") updateNeeded = true;
  emit({ type: "error", code });
  emit({ type: "change" });
  // 合言葉がちがう・保存先が古い版のときは、すぐ送り直しても通らない(入れ直し・更新のあとで送る)
  if (code !== "auth" && code !== "unknown_action") scheduleRetry();
}

async function run() {
  clearTimeout(retryTimer);
  await initPhotos();
  for (;;) {
    if (!store.getAikotoba() || !store.getUser()) return;
    const upload = myUploads()[0];
    const removal = upload ? null : myRemovals()[0];
    if (!upload && !removal) return;

    if (navigator.onLine === false) {
      stopWith("network");
      return;
    }

    if (upload) {
      uploadState.set(upload.id, "sending");
      emit({ type: "change" });
      try {
        // 送る前に「送ろうとした」印を付けておく(送信中に閉じられても、保存先にあるかもしれないと分かるように)
        if (!upload.tried) {
          upload.tried = true;
          await db.putUpload(upload);
        }
        const data = await db.getBlob(upload.id);
        if (!data) {
          // 中身が端末から消えていた(保存場所が片づけられた等)。送れないので、外す
          uploads.delete(upload.id);
          uploadState.delete(upload.id);
          localIds.delete(upload.id);
          await db.deleteUpload(upload.id);
          emit({ type: "change" });
          continue;
        }
        const result = await addPhoto(upload.id, toBase64(data));
        // 送っているあいだに外されていたら、一覧には足さない(「外す」が、このあと送られる)
        if (uploads.has(upload.id)) {
          uploads.delete(upload.id);
          uploadState.delete(upload.id);
          await db.deleteUpload(upload.id);
          uploadedAt.set(upload.id, Date.now());
          const photos = store.getPhotos().filter((p) => p.id !== upload.id);
          photos.push({
            id: upload.id,
            足した人: result["足した人"] || upload.user,
            追加日時: result["追加日時"] || "",
          });
          store.setPhotos(photos);
        }
        updateNeeded = false;
        emit({ type: "sent", id: upload.id });
        emit({ type: "change" });
      } catch (err) {
        const code = err instanceof ApiError ? err.code : "unknown";
        if (code === "invalid") {
          // 送り直しても通らない(大きすぎる・アルバムがいっぱい等)。端末からも外して、知らせる
          uploads.delete(upload.id);
          uploadState.delete(upload.id);
          await db.deleteUpload(upload.id).catch(() => {});
          await forget(upload.id);
          emit({ type: "dropped", code, id: upload.id, reason: (err.data && err.data.reason) || "" });
          emit({ type: "change" });
          continue;
        }
        stopWith(code);
        return;
      }
      continue;
    }

    try {
      await removePhoto(removal.id);
      store.setPhotoRemovals(store.getPhotoRemovals().filter((r) => r.id !== removal.id));
      removedAt.set(removal.id, Date.now());
      updateNeeded = false;
      emit({ type: "change" });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "unknown";
      if (code === "invalid") {
        store.setPhotoRemovals(store.getPhotoRemovals().filter((r) => r.id !== removal.id));
        continue;
      }
      stopWith(code);
      return;
    }
  }
}

// --- 取る ---------------------------------------------------------------------

/**
 * 写真の中身を、端末に無ければ保存先から取って保存する。
 * @param {string} id
 * @param {boolean} [force] 少し前に失敗していても、すぐ試す
 * @returns {Promise<boolean>} 端末にあるか
 */
export function ensurePhoto(id, force = false) {
  if (localIds.has(id)) return Promise.resolve(true);
  if (fetching.has(id)) return fetching.get(id);
  if (!store.getAikotoba() || store.getPhotosReady() === false || navigator.onLine === false) return Promise.resolve(false);
  if (!force && Date.now() - (fetchFailedAt.get(id) || 0) < FETCH_COOLDOWN_MS) return Promise.resolve(false);

  const work = (async () => {
    try {
      const result = await getPhoto(id);
      const data = fromBase64(String(result["データ"] || ""));
      if (!isJpeg(data)) throw new Error("not jpeg");
      // 取りに行っているあいだに外されていたら、保存しない
      if (!store.getPhotos().some((p) => p.id === id)) return false;
      await db.putBlob(id, data);
      localIds.add(id);
      fetchFailedAt.delete(id);
      emit({ type: "change" });
      return true;
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "unknown";
      if (code === "not_found") {
        // もうアルバムにない(相手が外した)。一覧からも外す
        store.setPhotos(store.getPhotos().filter((p) => p.id !== id));
        emit({ type: "change" });
      } else {
        fetchFailedAt.set(id, Date.now());
        if (code === "auth") emit({ type: "error", code });
      }
      return false;
    } finally {
      fetching.delete(id);
    }
  })();
  fetching.set(id, work);
  return work;
}

/** まだ端末に無い写真を、すべて取る(アルバムを開いたとき)。いちどに数枚ずつ */
export async function ensureAll() {
  await initPhotos();
  const ids = listPhotos()
    .filter((p) => !p.local)
    .map((p) => p.id);
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      await ensurePhoto(id, true);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_PARALLEL, ids.length) }, worker));
}

/** いま取りに行っている最中か(アルバムの「読みこみ中」の表示用) */
export function isFetching(id) {
  return fetching.has(id);
}

// --- 保存先から届いた一覧 -------------------------------------------------------

/**
 * sync などで届いた写真の一覧を、端末に保存する。一覧から消えた写真は、端末からも消す。
 * @param {object[] | undefined} list 配列でなければ、保存先(GAS)が古い版(アルバムは、更新されるまで使えない)
 */
export async function applyServerList(list) {
  if (!Array.isArray(list)) {
    store.setPhotosReady(false);
    emit({ type: "change" });
    return;
  }
  const wasReady = store.getPhotosReady();
  store.setPhotosReady(true);
  await initPhotos();

  const now = Date.now();
  const recent = (map, id) => now - (map.get(id) || 0) < RECENT_MS;
  const removing = removingIds();
  const old = new Map(store.getPhotos().map((p) => [p.id, p]));
  const next = [];
  const seen = new Set();
  for (const p of list) {
    if (!p || typeof p.id !== "string" || !p.id || seen.has(p.id)) continue;
    // 外している途中・外したばかりの写真は、一覧に戻さない
    if (removing.has(p.id) || recent(removedAt, p.id)) continue;
    seen.add(p.id);
    next.push({ id: p.id, 足した人: String(p["足した人"] || ""), 追加日時: String(p["追加日時"] || "") });
  }
  // 送ったばかりの写真が、行きちがいで届いた古い一覧に無くても、消さない
  for (const [id, p] of old) {
    if (!seen.has(id) && recent(uploadedAt, id)) {
      seen.add(id);
      next.push(p);
    }
  }
  store.setPhotos(next);

  // 一覧に無く、これから送るものでもない写真は、端末から消す
  for (const id of Array.from(localIds)) {
    if (!seen.has(id) && !uploads.has(id)) await forget(id);
  }
  emit({ type: "change" });

  // 保存先が新しい版になった・送れずに待っていたものがある → 送る
  if (wasReady !== true || updateNeeded) {
    updateNeeded = false;
    for (const [id, state] of uploadState) {
      if (state === "failed") uploadState.delete(id);
    }
  }
  if (pendingCount() > 0) flush();
}

// --- 写真の枠(入力の上部・「見る」の共同口座カード・「毎月の設定」の見出し) ---------

/** 写真の枠に出せる写真の id(アルバムの写真と、自分が足したばかりの写真) */
function shownIds() {
  return listPhotos().map((p) => p.id);
}

const slots = new Set();

/**
 * 写真の枠を1つ受け持つ。写真が1枚もないあいだは、もとの仮の絵のまま。
 *   frame … 枠(data-state を "photo" / "placeholder" に切り替える。仮の絵は CSS が出し分ける)
 *   img   … 写真を入れる <img>(hidden を外して src を入れる)
 * @returns {{shuffle: () => void}} shuffle = 別の写真に替える(開くたびに呼ぶ)
 */
export function createSlot(frame, img) {
  const slot = { id: "", token: 0 };

  const clear = () => {
    slot.id = "";
    img.hidden = true;
    img.removeAttribute("src");
    frame.dataset.state = "placeholder";
  };

  const show = async (id) => {
    const token = ++slot.token;
    const url = await getUrl(id);
    if (token !== slot.token) return;
    if (!url) {
      clear();
      return;
    }
    slot.id = id;
    if (img.getAttribute("src") !== url) img.src = url;
    img.hidden = false;
    frame.dataset.state = "photo";
  };

  /**
   * ランダムに1枚えらんで出す。
   * まず、端末に中身がある写真の中から出す(通信を待たせない)。
   * えらばれた写真が端末に無ければ、裏で取っておく(届いたら、次からはそれも出る。なにも出ていなければ、すぐ出す)。
   */
  const pick = async (avoid) => {
    await initPhotos();
    const ids = shownIds();
    if (ids.length === 0) {
      slot.token += 1;
      clear();
      return;
    }
    const candidates = ids.length > 1 ? ids.filter((id) => id !== avoid) : ids;
    const chosen = candidates[Math.floor(Math.random() * candidates.length)];
    if (localIds.has(chosen)) {
      await show(chosen);
      return;
    }
    // 裏で取るのは、いちどに1枚だけ(枠がいくつあっても、合図が重なっても、まとめて何枚も取りに行かない)
    if (fetching.size === 0) ensurePhoto(chosen);
    const locals = candidates.filter((id) => localIds.has(id));
    if (locals.length > 0) {
      await show(locals[Math.floor(Math.random() * locals.length)]);
    } else if (!(slot.id && localIds.has(slot.id) && ids.includes(slot.id))) {
      slot.token += 1;
      clear();
    }
  };

  // 読めない写真(こわれている等)だったら、仮の絵に戻す
  img.addEventListener("error", () => {
    if (!img.hidden) clear();
  });

  // えらんでいる最中に次の合図が来たら、終わってから、もういちどだけ確かめる(同時に何回もえらばない)
  let picking = false;
  let again = false;
  const start = (avoid) => {
    if (picking) {
      again = true;
      return;
    }
    picking = true;
    pick(avoid)
      .catch((err) => console.error(err))
      .finally(() => {
        picking = false;
        if (again) {
          again = false;
          slot.refresh();
        }
      });
  };

  slot.shuffle = () => start(slot.id);
  /**
   * 写真が増えた・減った・届いた: 出している写真がまだあれば、そのまま。無くなっていれば、えらび直す。
   * 見えていない画面の枠は、えらび直さない(写真を取りに行かない)。その画面を開いたときに shuffle でえらぶ
   */
  slot.refresh = () => {
    if (slot.id && localIds.has(slot.id) && shownIds().includes(slot.id)) return;
    if (frame.offsetParent === null) {
      if (slot.id) {
        slot.token += 1;
        clear();
      }
      return;
    }
    start("");
  };
  slots.add(slot);
  return slot;
}

subscribe((event) => {
  if (event.type !== "change") return;
  for (const slot of slots) slot.refresh();
});
