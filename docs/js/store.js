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

/** 未送信のキュー(なければ空の配列) */
export function getQueue() {
  return readList(KEYS.queue);
}

/** 未送信のキューを書く。書けなかったら false(容量不足・プライベートブラウズなど) */
export function setQueue(queue) {
  return write(KEYS.queue, JSON.stringify(Array.isArray(queue) ? queue : []));
}
