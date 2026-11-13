// 小さな道具(日付・金額・id)。画面にも通信にも依存しない。

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * 端末のローカル日付を 'YYYY-MM-DD' にする。
 * ※ toISOString() は UTC になり、日本では朝9時まで前日になってしまうので使わない。
 */
export function toDateString(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** きょう(端末のローカル日付)の 'YYYY-MM-DD' */
export function todayString() {
  return toDateString(new Date());
}

/** 'YYYY-MM-DD' かどうか(実在する日付だけ通す) */
export function isDateString(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text));
  if (!m) return false;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return toDateString(date) === text;
}

/** 'YYYY-MM-DD' → '11/13(金)' */
export function formatDateShort(dateString) {
  const [y, m, d] = dateString.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return `${m}/${d}（${WEEKDAYS[date.getDay()]}）`;
}

/** 入力された文字から数字だけを取り出す(全角数字は半角に直す)。先頭の 0 は取る */
export function digitsOnly(text) {
  return String(text)
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\D/g, "")
    .replace(/^0+/, "");
}

/** 1200 → '1,200' */
export function formatAmount(amount) {
  return Number(amount).toLocaleString("ja-JP");
}

/** 記録の id(UUID)。古い iPhone で randomUUID が無いときは、乱数から同じ形を作る */
export function newId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
