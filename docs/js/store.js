// 端末(この iPhone)に覚えさせておく値の出し入れ。
// localStorage のキー名はここだけで決める(ほかのファイルに直書きしない)。

export const KEYS = Object.freeze({
  aikotoba: "goma.aikotoba",     // 合言葉(初回に入れたもの。以降の通信で毎回使う)
  user: "goma.user",             // この iPhone の持ち主: "ゆうき" | "まゆ"
  categories: "goma.categories", // 変動費のカテゴリ一覧(JSON の配列。前回取得分)
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

/** この iPhone の登録を消す(合言葉を入れ直すとき) */
export function clearLogin() {
  remove(KEYS.aikotoba);
  remove(KEYS.user);
}
