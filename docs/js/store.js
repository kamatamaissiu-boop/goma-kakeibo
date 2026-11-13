// 端末(この iPhone)に覚えさせておく値の出し入れ。
// localStorage のキー名はここだけで決める(ほかのファイルに直書きしない)。

export const KEYS = Object.freeze({
  aikotoba: "goma.aikotoba",     // 合言葉(初回に入れたもの。以降の通信で毎回使う)
  user: "goma.user",             // この iPhone の持ち主: "ゆうき" | "まゆ"
  categories: "goma.categories", // 変動費のカテゴリ一覧(JSON の配列。前回取得分)
  wallet: "goma.wallet",         // 入力画面で前回えらんだ財布: "self" | "joint"
  records: "goma.records",       // 記録の一覧(JSON の配列。前回取得分。候補の表示や「見る」で使う)
  queue: "goma.queue",           // まだ保存先に送れていない操作(JSON の配列。queue.js が使う)
  syncedAt: "goma.syncedAt",     // 記録の一覧を最後に取れた時刻(ミリ秒)。一度も取れていなければ無い
  monthlyItems: "goma.monthlyItems",   // 毎月の項目(JSON の配列。前回取得分)
  monthlyClosed: "goma.monthlyClosed", // 月の確定の一覧(JSON の配列。前回取得分)
  monthlyReady: "goma.monthlyReady",   // 保存先が「毎月の設定」に対応した版か: "1" | "0"(まだ分からなければ無い)
  monthlyDrafts: "goma.monthlyDrafts", // 毎月の設定の下書き(JSON。「名前|月」→ { 項目id: 入力中の金額 })
  photos: "goma.photos",               // アルバムの写真の一覧(JSON の配列 {id, 足した人, 追加日時}。前回取得分。写真の中身は photos.js が別に保存する)
  photosReady: "goma.photosReady",     // 保存先が「アルバム」に対応した版か: "1" | "0"(まだ分からなければ無い)
  photoRemovals: "goma.photoRemovals", // まだ保存先に送れていない「写真を外す」(JSON の配列 {id, user})
});

// プライベートブラウズなどで localStorage が使えない場合も、画面が止まらないようにする
function read(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function remove(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* 何もしない */
  }
}

/** 覚えている合言葉(なければ空文字) */
export function getAikotoba() {
  return read(KEYS.aikotoba) || "";
}

/** この iPhone の持ち主の名前(なければ空文字) */
export function getUser() {
  return read(KEYS.user) || "";
}

/** カテゴリ一覧(なければ空の配列) */
export function getCategories() {
  try {
    const list = JSON.parse(read(KEYS.categories) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** 合言葉が通ったときに、合言葉・名前・カテゴリをまとめて覚える */
export function saveLogin({ aikotoba, user, categories }) {
  const ok = write(KEYS.aikotoba, aikotoba) && write(KEYS.user, user);
  if (Array.isArray(categories)) {
    write(KEYS.categories, JSON.stringify(categories));
  }
  return ok;
}

/**
 * この iPhone の登録を消す(合言葉を入れ直すとき)。
 * 前回取得した記録も消す。未送信のキューは消さない(同じ人が入れ直せば、あとで送られる)。
 */
export function clearLogin() {
  remove(KEYS.aikotoba);
  remove(KEYS.user);
  remove(KEYS.records);
  remove(KEYS.syncedAt);
  remove(KEYS.monthlyItems);
  remove(KEYS.monthlyClosed);
  remove(KEYS.monthlyReady);
  remove(KEYS.photosReady);
  // アルバムの写真の一覧と中身は消さない(2人で同じものなので、だれが入れ直しても、そのまま使える)
  // 毎月の設定の下書きは消さない(名前ごとに分けてあるので、同じ人が入れ直せば続きから)
}

function readList(key) {
  try {
    const list = JSON.parse(read(key) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** カテゴリ一覧だけを覚え直す */
export function saveCategories(categories) {
  if (Array.isArray(categories)) {
    write(KEYS.categories, JSON.stringify(categories));
  }
}

/** 前回えらんだ財布("self" = 自分 / "joint" = 共同口座)。初期値は自分 */
export function getWallet() {
  return read(KEYS.wallet) === "joint" ? "joint" : "self";
}

export function setWallet(wallet) {
  write(KEYS.wallet, wallet === "joint" ? "joint" : "self");
}

/** 前回取得した記録の一覧(なければ空の配列) */
export function getRecords() {
  return readList(KEYS.records);
}

export function setRecords(records) {
  return write(KEYS.records, JSON.stringify(Array.isArray(records) ? records : []));
}

/** 記録の一覧を最後に取れた時刻(ミリ秒)。一度も取れていなければ 0 */
export function getSyncedAt() {
  return Number(read(KEYS.syncedAt)) || 0;
}

export function markSynced() {
  write(KEYS.syncedAt, String(Date.now()));
}

// --- 毎月の設定 ---------------------------------------------------------------

/** 前回取得した、毎月の項目(固定費・貯蓄・収入・税金のひな形。相手の分も入っている) */
export function getMonthlyItems() {
  return readList(KEYS.monthlyItems);
}

/** 前回取得した、月の確定の一覧({月, 確定した人, 確定日時}) */
export function getMonthlyClosed() {
  return readList(KEYS.monthlyClosed);
}

export function setMonthlyData(items, closed) {
  write(KEYS.monthlyItems, JSON.stringify(Array.isArray(items) ? items : []));
  write(KEYS.monthlyClosed, JSON.stringify(Array.isArray(closed) ? closed : []));
}

/**
 * 保存先(GAS)が「毎月の設定」に対応した版か。
 * @returns {boolean | null} null = まだ一度も確かめられていない
 */
export function getMonthlyReady() {
  const value = read(KEYS.monthlyReady);
  return value === "1" ? true : value === "0" ? false : null;
}

export function setMonthlyReady(ready) {
  write(KEYS.monthlyReady, ready ? "1" : "0");
}

function readDrafts() {
  try {
    const all = JSON.parse(read(KEYS.monthlyDrafts) || "{}");
    return all && typeof all === "object" && !Array.isArray(all) ? all : {};
  } catch {
    return {};
  }
}

/** 毎月の設定の下書き({ 項目id: 入力中の金額(数字だけの文字。空文字 = 消した) })。なければ空 */
export function getMonthlyDraft(user, month) {
  const draft = readDrafts()[`${user}|${month}`];
  return draft && typeof draft === "object" && !Array.isArray(draft) ? draft : {};
}

/** 下書きを書く。中身が空なら、その月の下書きを消す。書けなかったら false */
export function setMonthlyDraft(user, month, draft) {
  const all = readDrafts();
  const key = `${user}|${month}`;
  if (draft && Object.keys(draft).length > 0) {
    all[key] = draft;
  } else {
    delete all[key];
  }
  return write(KEYS.monthlyDrafts, JSON.stringify(all));
}

// --- アルバム(写真の一覧だけ。写真の中身は大きいので、photos.js が IndexedDB に保存する) ----

/** 前回取得した、アルバムの写真の一覧({id, 足した人, 追加日時}) */
export function getPhotos() {
  return readList(KEYS.photos).filter((p) => p && typeof p.id === "string" && p.id);
}

export function setPhotos(list) {
  return write(KEYS.photos, JSON.stringify(Array.isArray(list) ? list : []));
}

/**
 * 保存先(GAS)が「アルバム」に対応した版か。
 * @returns {boolean | null} null = まだ一度も確かめられていない
 */
export function getPhotosReady() {
  const value = read(KEYS.photosReady);
  return value === "1" ? true : value === "0" ? false : null;
}

export function setPhotosReady(ready) {
  write(KEYS.photosReady, ready ? "1" : "0");
}

/** まだ保存先に送れていない「写真を外す」({id, user}。古い順) */
export function getPhotoRemovals() {
  return readList(KEYS.photoRemovals).filter((p) => p && typeof p.id === "string" && p.id);
}

export function setPhotoRemovals(list) {
  return write(KEYS.photoRemovals, JSON.stringify(Array.isArray(list) ? list : []));
}

/** 未送信のキュー(なければ空の配列) */
export function getQueue() {
  return readList(KEYS.queue);
}

/** 未送信のキューを書く。書けなかったら false(容量不足・プライベートブラウズなど) */
export function setQueue(queue) {
  return write(KEYS.queue, JSON.stringify(Array.isArray(queue) ? queue : []));
}
