// 「見る」の集計(仕様書 4.2)。画面にも通信にも依存しない(計算だけ)。
//
// 集計の決まり(段階2)
//   共同口座
//     入金 = その月の「共同へ入金」の合計(2人分。だれが入れたかは 財布 の列)
//     支出 = その月の、財布が共同口座の 変動費 + 特別費
//     残り = 入金 − 支出
//   自分の財布
//     合計 = その月の、財布が自分の 変動費 + 特別費(見本どおり。「共同へ入金」は含めない)
//     「共同へ入金」は、合計とは別の行で見せる(自分の財布から出たお金だが、使ったお金ではないので)
//   月は、記録の 日付 の年月で決める。
//   相手の財布の記録は、どこにも混ぜない(相手の「共同へ入金」だけは、共同口座の入金に数える)。

import { USERS, WALLET_JOINT } from "./config.js";

export const KIND = Object.freeze({ VARIABLE: "変動費", SPECIAL: "特別費", DEPOSIT: "共同へ入金" });

/** アプリの画面から入力・修正できる種類 */
export const APP_KINDS = Object.freeze([KIND.VARIABLE, KIND.SPECIAL, KIND.DEPOSIT]);

/** 支出として数える種類。段階3で固定費を記録するようになったら、ここに足す */
export const SPEND_KINDS = Object.freeze([KIND.VARIABLE, KIND.SPECIAL]);

/** カテゴリが空の変動費を、まとめる名前 */
export const NO_CATEGORY = "未分類";

function pad2(n) {
  return String(n).padStart(2, "0");
}

function amountOf(record) {
  const n = Number(record["金額"]);
  return Number.isFinite(n) ? n : 0;
}

/** 記録の月('YYYY-MM')。日付から決める。日付が読めないときだけ「月」の列を使う */
export function recordMonth(record) {
  const date = String(record["日付"] || "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date.slice(0, 7);
  return String(record["月"] || "");
}

/** 'YYYY-MM' を delta か月ずらす */
export function addMonth(month, delta) {
  const [y, m] = month.split("-").map(Number);
  const index = y * 12 + (m - 1) + delta;
  return `${Math.floor(index / 12)}-${pad2((index % 12) + 1)}`;
}

/** ミリ秒の時刻 → 'YYYY-MM-DD HH:mm:ss'(端末のローカル時刻) */
export function toDateTimeString(ms) {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

/**
 * 前回取得した記録に、まだ送れていない操作(追加・修正・削除)を重ねる。
 * 押した直後に「見る」を開いても、数字が合うようにするため。
 * @param {object[]} saved 前回取得した記録
 * @param {object[]} ops   未送信キュー(古い順)
 * @param {string} user    この iPhone の持ち主(ほかの人が積んだ分は重ねない)
 * @returns {{records: object[], pendingIds: Set<string>}} pendingIds = まだ送れていない記録の id
 */
export function applyQueue(saved, ops, user) {
  const map = new Map();
  for (const record of saved) {
    if (record && record.id) map.set(record.id, record);
  }
  const pendingIds = new Set();
  for (const op of ops) {
    if (!op || op.user !== user) continue;
    if (op.op === "add" && op.record) {
      map.set(op.record.id, {
        ...op.record,
        月: recordMonth(op.record),
        作成日時: toDateTimeString(op.createdAt || Date.now()),
        記録した人: user,
        元: "アプリ",
      });
      pendingIds.add(op.record.id);
    } else if (op.op === "update" && op.record) {
      const current = map.get(op.record.id);
      if (current) {
        map.set(op.record.id, { ...current, ...op.record, 月: recordMonth(op.record) });
        pendingIds.add(op.record.id);
      }
    } else if (op.op === "delete") {
      map.delete(op.id);
      pendingIds.delete(op.id);
    }
  }
  return { records: Array.from(map.values()), pendingIds };
}

/** この人の画面に出してよい記録か(自分の財布・共同口座・だれかの「共同へ入金」) */
export function isVisible(record, user) {
  return record["財布"] === user || record["財布"] === WALLET_JOINT || record["種類"] === KIND.DEPOSIT;
}

/** この人が、なおしたり消したりできる記録か(保存先の決まりと同じ) */
export function canEdit(record, user) {
  if (!APP_KINDS.includes(record["種類"])) return false;
  return record["財布"] === user || record["財布"] === WALLET_JOINT || record["記録した人"] === user;
}

/**
 * 切り替えられる月の範囲。記録のある最古の月 〜 今月(先の日付の記録があれば、その月まで)。
 * @returns {{min: string, max: string}}
 */
export function monthRange(records, user, thisMonth) {
  let min = thisMonth;
  let max = thisMonth;
  for (const record of records) {
    if (!isVisible(record, user)) continue;
    const month = recordMonth(record);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    if (month < min) min = month;
    if (month > max) max = month;
  }
  return { min, max };
}

function newestFirst(a, b) {
  const ka = `${a["日付"] || ""} ${a["作成日時"] || ""} ${a.id || ""}`;
  const kb = `${b["日付"] || ""} ${b["作成日時"] || ""} ${b.id || ""}`;
  return ka < kb ? 1 : ka > kb ? -1 : 0;
}

/**
 * その月の集計。
 * @param {object[]} records 記録(未送信の分を重ねたもの)
 * @param {string} user      この iPhone の持ち主
 * @param {string} month     'YYYY-MM'
 */
export function summarize(records, user, month) {
  const list = records.filter((r) => isVisible(r, user) && recordMonth(r) === month);

  // --- 共同口座 ---
  const byName = new Map();
  let deposit = 0;
  let jointSpend = 0;
  for (const r of list) {
    const amount = amountOf(r);
    if (r["種類"] === KIND.DEPOSIT) {
      deposit += amount;
      byName.set(r["財布"], (byName.get(r["財布"]) || 0) + amount);
    } else if (r["財布"] === WALLET_JOINT && SPEND_KINDS.includes(r["種類"])) {
      jointSpend += amount;
    }
  }
  // 内訳は、いつも ゆうき → まゆ の順(入れていない人は 0)
  const depositBy = USERS.map((name) => ({ name, amount: byName.get(name) || 0 }));
  for (const [name, amount] of byName) {
    if (!USERS.includes(name)) depositBy.push({ name, amount });
  }

  let state;
  let ratio; // 支出 ÷ 入金(入金が 0 のときは null)
  if (deposit > 0) {
    ratio = jointSpend / deposit;
    state = ratio > 1 ? "over" : ratio >= 0.8 ? "warn" : "good";
  } else {
    ratio = null;
    state = jointSpend > 0 ? "nodeposit" : "empty";
  }
  const joint = {
    deposit,
    depositBy,
    spend: jointSpend,
    remain: deposit - jointSpend,
    ratio,
    // ゲージの進み(0〜1)。入金が 0 で支出があるとき・使いすぎのときは、右端まで
    gauge: ratio === null ? (jointSpend > 0 ? 1 : 0) : Math.min(1, ratio),
    state,
  };

  // --- 自分の財布 ---
  const categoryMap = new Map();
  const specials = [];
  let walletTotal = 0;
  let walletDeposit = 0;
  for (const r of list) {
    if (r["財布"] !== user) continue;
    const amount = amountOf(r);
    if (r["種類"] === KIND.VARIABLE) {
      const name = String(r["項目"] || "").trim() || NO_CATEGORY;
      categoryMap.set(name, (categoryMap.get(name) || 0) + amount);
      walletTotal += amount;
    } else if (r["種類"] === KIND.SPECIAL) {
      specials.push(r);
      walletTotal += amount;
    } else if (r["種類"] === KIND.DEPOSIT) {
      walletDeposit += amount;
    }
  }
  // 金額の大きい順(同じ金額なら、先に出てきた順)
  const categories = Array.from(categoryMap, ([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount);
  specials.sort(newestFirst);

  const wallet = {
    total: walletTotal,
    categories,
    max: categories.length ? categories[0].amount : 0,
    specials: specials.map((r) => ({ id: r.id, memo: String(r["メモ"] || ""), amount: amountOf(r) })),
    deposit: walletDeposit,
  };

  return { month, count: list.length, joint, wallet, details: list.slice().sort(newestFirst) };
}

/**
 * 明細のしぼりこみ。
 * @param {"all" | "self" | "joint"} filter
 *   self  … 自分の財布の記録(自分の「共同へ入金」も、自分の財布から出たお金なので含む)
 *   joint … 共同口座の記録と、2人の「共同へ入金」
 */
export function filterDetails(details, user, filter) {
  if (filter === "self") return details.filter((r) => r["財布"] === user);
  if (filter === "joint") return details.filter((r) => r["財布"] === WALLET_JOINT || r["種類"] === KIND.DEPOSIT);
  return details;
}
