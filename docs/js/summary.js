// 「見る」の集計(仕様書 4.2)。画面にも通信にも依存しない(計算だけ)。
//
// 集計の決まり
//   共同口座
//     入金 = その月の「共同へ入金」の合計(2人分。だれが入れたかは 財布 の列)
//     支出 = その月の、財布が共同口座の 変動費 + 特別費 + 固定費(固定費は「毎月の設定」で確定した分)
//     残り = 入金 − 支出
//   自分の財布
//     合計 = その月の、財布が自分の 変動費 + 特別費 + 固定費(= つかったお金)
//     横棒のグラフは変動費のカテゴリだけ。特別費は1行ずつ、固定費は合計を1行で見せる(グラフには混ぜない)
//     「貯蓄」は支出ではなく「貯めたお金」。合計には入れず、別の行で見せる
//     「共同へ入金」も、合計とは別の行で見せる(自分の財布から出たお金だが、使ったお金ではないので)
//     「収入」は手取りの合計を1行で見せる。「税金」は「見る」には出さない(手取りは税金を引いたあとの金額なので)
//   月は、記録の 日付 の年月で決める(確定した固定費などは、その月の1日付け)。
//   相手の財布の記録は、どこにも混ぜない(相手の「共同へ入金」だけは、共同口座の入金に数える)。
//   「来月、共同口座に入れる目安」の決まりは estimateNextDeposit の説明に書いてある。

import { USERS, WALLET_JOINT } from "./config.js";

export const KIND = Object.freeze({ VARIABLE: "変動費", SPECIAL: "特別費", DEPOSIT: "共同へ入金" });

/** アプリの画面から入力・修正できる種類 */
export const APP_KINDS = Object.freeze([KIND.VARIABLE, KIND.SPECIAL, KIND.DEPOSIT]);

/** 「毎月の設定」で確定する種類(保存先の「区分」と同じ文字) */
export const MONTHLY = Object.freeze({ FIXED: "固定費", SAVING: "貯蓄", INCOME: "収入", TAX: "税金" });
export const MONTHLY_KINDS = Object.freeze([MONTHLY.FIXED, MONTHLY.SAVING, MONTHLY.INCOME, MONTHLY.TAX]);

/** 支出として数える種類(貯蓄・収入・税金は入れない) */
export const SPEND_KINDS = Object.freeze([KIND.VARIABLE, KIND.SPECIAL, MONTHLY.FIXED]);

/** 明細に出す種類(収入・税金は「毎月の設定」で見る) */
export const DETAIL_KINDS = Object.freeze([...APP_KINDS, MONTHLY.FIXED, MONTHLY.SAVING]);

/** 「毎月の設定」で確定した記録か(明細からは直せない。直すのは「毎月の設定」で) */
export function isAuto(record) {
  return MONTHLY_KINDS.includes(record["種類"]) || record["元"] === "自動";
}

/** 確定した記録の id(保存先と同じ決まり): auto-年月-項目id */
export function autoRecordId(month, itemId) {
  return `auto-${month.replace("-", "")}-${itemId}`;
}

/** 確定した記録の id から、月と項目の id を取り出す。ちがう形なら null */
export function parseAutoId(id) {
  const m = /^auto-(\d{4})(\d{2})-(.+)$/.exec(String(id || ""));
  return m ? { month: `${m[1]}-${m[2]}`, itemId: m[3] } : null;
}

/** 共同口座が「順調」(香箱座りの絵)になる、支出 ÷ 入金 の上限 */
export const JOINT_GOOD_RATIO = 0.7;

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

const WEEKDAY_LABELS = ["月", "火", "水", "木", "金", "土", "日"];

function toDateOnly(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * 「記録した日」('YYYY-MM-DD')。お金が動いた日(日付)ではなく、アプリに入れた日(作成日時)で数える。
 * あとから前の日付でまとめて入れても「きょう、つけた」ことになるように(入力画面の、ねむる・ジト目と同じ決まり)。
 * 作成日時が読めないときだけ、日付を使う。
 */
export function recordedDay(record) {
  const created = String((record && record["作成日時"]) || "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(created)) return created;
  const date = String((record && record["日付"]) || "");
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
}

/**
 * 「今週の肉球スタンプ」(仕様書 4.2 の 2)。きょうを含む週の、月曜〜日曜の7日。
 * スタンプが付くのは、自分がアプリで1件以上記録した日:
 *   - 記録した人が自分で、元が「アプリ」の記録(財布は、自分でも共同口座でもよい)。
 *     相手の記録・「毎月の設定」の自動の記録・フォームから取り込んだ記録は数えない。
 *   - 日にちは「記録した日」(recordedDay)。
 *   - まだ送れていない記録も数えるには、applyQueue で重ねた一覧を渡す。
 * @param {object[]} records 記録の一覧
 * @param {string} user この iPhone の持ち主
 * @param {string} today きょう 'YYYY-MM-DD'
 * @returns {{date: string, label: string, stamped: boolean, isToday: boolean, isFuture: boolean}[]} 月曜から順に7つ
 */
export function weekStamps(records, user, today) {
  const [y, m, d] = today.split("-").map(Number);
  const base = new Date(y, m - 1, d);
  const fromMonday = (base.getDay() + 6) % 7; // 月 = 0 … 日 = 6
  const days = new Set();
  for (const r of records) {
    if (!r || r["記録した人"] !== user || r["元"] !== "アプリ") continue;
    const day = recordedDay(r);
    if (day) days.add(day);
  }
  return WEEKDAY_LABELS.map((label, i) => {
    const date = toDateOnly(new Date(y, m - 1, d - fromMonday + i));
    return { date, label, stamped: days.has(date), isToday: date === today, isFuture: date > today };
  });
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
  let jointFixed = 0; // 支出のうち、固定費の分
  for (const r of list) {
    const amount = amountOf(r);
    if (r["種類"] === KIND.DEPOSIT) {
      deposit += amount;
      byName.set(r["財布"], (byName.get(r["財布"]) || 0) + amount);
    } else if (r["財布"] === WALLET_JOINT && SPEND_KINDS.includes(r["種類"])) {
      jointSpend += amount;
      if (r["種類"] === MONTHLY.FIXED) jointFixed += amount;
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
    fixed: jointFixed,
    remain: deposit - jointSpend,
    ratio,
    // ゲージの進み(0〜1)。入金が 0 で支出があるとき・使いすぎのときは、右端まで
    gauge: ratio === null ? (jointSpend > 0 ? 1 : 0) : Math.min(1, ratio),
    state,
    // ごまちゃんのようす(絵): 支出が入金の 70% 以下 = 順調("loaf" 香箱座り) / 入金を超えた = 使いすぎ("jito" ジト目)。
    // 入金の記録がない月は、ジト目にしない(入金をまだ入れていないだけかもしれないので)。
    // 70% を超えて 100% までは、絵なし(一言は、80% 以上で「そろそろ気をつけるにゃ」)
    mood: ratio === null ? "" : ratio > 1 ? "jito" : ratio <= JOINT_GOOD_RATIO ? "loaf" : "",
  };

  // --- 自分の財布 ---
  const categoryMap = new Map();
  const specials = [];
  let walletTotal = 0;
  let walletDeposit = 0;
  const fixed = { total: 0, items: [] };  // 固定費(合計に入れる。グラフには混ぜない)
  const saving = { total: 0, items: [] }; // 貯蓄(合計に入れない。「貯めたお金」)
  let income = 0;                         // 収入(手取り)の合計
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
    } else if (r["種類"] === MONTHLY.FIXED) {
      fixed.total += amount;
      fixed.items.push({ name: String(r["項目"] || ""), amount });
      walletTotal += amount;
    } else if (r["種類"] === MONTHLY.SAVING) {
      saving.total += amount;
      saving.items.push({ name: String(r["項目"] || ""), amount });
    } else if (r["種類"] === MONTHLY.INCOME) {
      income += amount;
    }
  }
  fixed.items.sort((a, b) => b.amount - a.amount);
  saving.items.sort((a, b) => b.amount - a.amount);
  // 金額の大きい順(同じ金額なら、先に出てきた順)
  const categories = Array.from(categoryMap, ([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount);
  specials.sort(newestFirst);

  const wallet = {
    total: walletTotal,
    categories,
    max: categories.length ? categories[0].amount : 0,
    specials: specials.map((r) => ({ id: r.id, memo: String(r["メモ"] || ""), amount: amountOf(r) })),
    deposit: walletDeposit,
    fixed,
    saving,
    income,
    // 収入との差し引き。その月に確定した自分の収入(手取り)があるときだけ(なければ null)。
    //   のこり = 収入(手取り) − 使ったお金(変動費+特別費+固定費 = 上の total) − 共同口座へ入金 − 貯めたお金(貯蓄)
    //   税金・社会保険は、手取りにはじめから入っていないので、引かない。相手の収入は、ここには来ない(自分の財布の記録だけ)
    balance:
      income > 0
        ? {
            income,
            spend: walletTotal,
            deposit: walletDeposit,
            saving: saving.total,
            remain: income - walletTotal - walletDeposit - saving.total,
          }
        : null,
  };

  // 明細には、収入・税金を出さない(「毎月の設定」で見る)
  const details = list.filter((r) => DETAIL_KINDS.includes(r["種類"])).sort(newestFirst);
  return { month, count: list.length, joint, wallet, details };
}

// --- 毎月の設定 ---------------------------------------------------------------

function itemOrder(a, b) {
  return (Number(a["並び順"]) || 0) - (Number(b["並び順"]) || 0);
}

/** その月の、確定した記録(項目の id → 記録)。削除されたものは、記録の一覧に入っていない */
export function autoRecordMap(records, month) {
  const map = new Map();
  for (const r of records) {
    const parsed = parseAutoId(r && r.id);
    if (parsed && parsed.month === month) map.set(parsed.itemId, r);
  }
  return map;
}

/** その月を確定した人(名前 → 確定日時) */
export function closedBy(closed, month) {
  const map = new Map();
  for (const c of closed) {
    if (c && c["月"] === month && c["確定した人"]) map.set(c["確定した人"], String(c["確定日時"] || ""));
  }
  return map;
}

/**
 * その月の「毎月の設定」に出す項目。自分の項目と、共同口座の項目だけ(相手の項目は出さない)。
 * 停止した項目は出さない。ただし、その月の記録が残っている項目は出す(過去の月を直せるように)。
 */
export function monthlyItemsFor(items, user, autoMap) {
  return items
    .filter((item) => item && (item["持ち主"] === user || item["持ち主"] === WALLET_JOINT))
    .filter((item) => MONTHLY_KINDS.includes(item["区分"]))
    .filter((item) => item["有効"] === true || autoMap.has(item.id))
    .sort(itemOrder);
}

/**
 * その項目の、その月の「もとの金額」(入力し直す前の値。数字だけの文字。空 = 金額なし)。
 *   1. その月の記録があれば、その金額
 *   2. 記録がなく、その月が確定済み(自分の項目は自分が、共同口座の項目はどちらかが確定)なら、空
 *      (確定したときに空だった、ということなので、保存してある内容のとおりに出す)
 *   3. まだ確定していない月は、「毎月おなじ」の固定費・貯蓄なら、登録してある金額(自動で入る)
 *   4. それ以外(毎月かわる・収入・税金・金額が未登録)は、空
 */
export function monthlyBase(item, autoMap, closedMap, user) {
  const record = autoMap.get(item.id);
  if (record) return String(amountOf(record) || "");
  const closed = item["持ち主"] === user ? closedMap.has(user) : closedMap.size > 0;
  if (closed) return "";
  const autoFill = (item["区分"] === MONTHLY.FIXED || item["区分"] === MONTHLY.SAVING) && item["毎月かわる"] !== true;
  const amount = Number(item["金額"]) || 0;
  return autoFill && amount > 0 ? String(amount) : "";
}

// --- 来月、共同口座に入れる目安(仕様書 4.2 の4) ---------------------------------

function daysInMonth(month) {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

/**
 * 来月、共同口座に入れる目安。
 *
 *   必要額 = 共同口座の固定費の合計 + 共同口座の変動費の平均(特別費は入れない)。1,000円単位に切り上げ。
 *
 *   固定費(いま有効な、共同口座の項目)
 *     - 「毎月おなじ」で金額が登録してある項目 → 登録してある金額(来月、自動で入る金額)
 *     - 「毎月かわる」項目(光熱費など)・金額が未登録の項目 → いちばん新しい月の確定額
 *       (季節で動くので、平均より直近のほうが近い。1つの数字なので検算もしやすい)
 *     - 一度も確定していなければ 0 円(内訳に「未入力」と出す)
 *
 *   変動費の平均
 *     - 先月までの直近3か月。今月は途中なので入れない(月の途中で数字がぶれないように)
 *     - 記録を始めた月より前は数えない(3か月に満たない間は、ある月だけで平均)
 *     - 記録を始めた月が月の途中からなら、その月は日割りで1か月分に直す
 *       (例: 10/19 から記録 → 10月の金額 × 31日 ÷ 13日)。そのままだと少なく出すぎるため
 *     - 先月までの月が1つもない(使い始めた月)ときだけ、今月の途中までを日割りで1か月分に直して使う
 *     - 記録を始めたあとで、共同口座の変動費が0円の月は、0円として平均に入れる
 *
 *   半々なら = 必要額 ÷ 2
 *   収入比なら = 必要額 × 自分の手取り ÷ 2人の手取り(1,000円単位に四捨五入)。
 *     手取りは、2人とも収入を確定している、いちばん新しい月のもの。そういう月が無ければ出さない(null)。
 *     相手の手取りの金額は、結果に入れない(どの月の比かだけを返す)。
 *
 * @param {object} p
 * @param {object[]} p.records 記録(相手の分も入った全件。未送信の分を重ねたもの)
 * @param {object[]} p.items   毎月の項目
 * @param {string} p.user      この iPhone の持ち主
 * @param {string} p.today     きょう 'YYYY-MM-DD'
 */
export function estimateNextDeposit({ records, items, user, today }) {
  const thisMonth = today.slice(0, 7);

  // --- 固定費 ---
  const latest = new Map(); // 項目の id → いちばん新しい月の確定した記録
  for (const r of records) {
    const parsed = parseAutoId(r && r.id);
    if (!parsed || r["種類"] !== MONTHLY.FIXED) continue;
    const current = latest.get(parsed.itemId);
    if (!current || parsed.month > current.month) latest.set(parsed.itemId, { month: parsed.month, amount: amountOf(r) });
  }
  const fixedItems = items
    .filter((item) => item && item["有効"] === true && item["持ち主"] === WALLET_JOINT && item["区分"] === MONTHLY.FIXED)
    .sort(itemOrder)
    .map((item) => {
      const registered = Number(item["金額"]) || 0;
      if (item["毎月かわる"] !== true && registered > 0) {
        return { name: item["項目名"], amount: registered, source: "registered", month: "" };
      }
      const last = latest.get(item.id);
      if (last && last.amount > 0) return { name: item["項目名"], amount: last.amount, source: "latest", month: last.month };
      return { name: item["項目名"], amount: 0, source: "none", month: "" };
    });
  const fixedTotal = fixedItems.reduce((sum, item) => sum + item.amount, 0);

  // --- 変動費の平均 ---
  const byMonth = new Map();
  let start = ""; // 記録を始めた日(確定した固定費などは数えない)
  for (const r of records) {
    if (!r || isAuto(r)) continue;
    const date = String(r["日付"] || "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && (!start || date < start)) start = date;
    if (r["財布"] === WALLET_JOINT && r["種類"] === KIND.VARIABLE) {
      const month = recordMonth(r);
      byMonth.set(month, (byMonth.get(month) || 0) + amountOf(r));
    }
  }
  const months = [];
  let basis = "none"; // "past" = 先月までの月 / "current" = 今月の途中まで / "none" = まだ記録がない
  if (start && start.slice(0, 7) <= thisMonth) {
    const startMonth = start.slice(0, 7);
    const startDay = Number(start.slice(8, 10));
    for (let i = 3; i >= 1; i--) {
      const month = addMonth(thisMonth, -i);
      if (month < startMonth) continue;
      const actual = byMonth.get(month) || 0;
      const total = daysInMonth(month);
      const days = month === startMonth ? total - startDay + 1 : total;
      months.push({ month, actual, days, daysInMonth: total, amount: Math.round((actual * total) / days), prorated: days < total });
    }
    if (months.length > 0) {
      basis = "past";
    } else {
      const actual = byMonth.get(thisMonth) || 0;
      const total = daysInMonth(thisMonth);
      const days = Math.min(total, Math.max(1, Number(today.slice(8, 10)) - startDay + 1));
      months.push({ month: thisMonth, actual, days, daysInMonth: total, amount: Math.round((actual * total) / days), prorated: days < total });
      basis = "current";
    }
  }
  const average = months.length ? Math.round(months.reduce((sum, m) => sum + m.amount, 0) / months.length) : 0;

  const raw = fixedTotal + average;
  const need = Math.ceil(raw / 1000) * 1000;

  // --- 収入比 ---
  const incomes = new Map(); // 月 → Map(名前 → 手取りの合計)
  for (const r of records) {
    if (!r || r["種類"] !== MONTHLY.INCOME) continue;
    const month = recordMonth(r);
    if (!incomes.has(month)) incomes.set(month, new Map());
    const m = incomes.get(month);
    m.set(r["財布"], (m.get(r["財布"]) || 0) + amountOf(r));
  }
  let byIncome = null;
  for (const month of Array.from(incomes.keys()).sort().reverse()) {
    const m = incomes.get(month);
    if (!USERS.every((name) => (m.get(name) || 0) > 0)) continue;
    const total = USERS.reduce((sum, name) => sum + m.get(name), 0);
    byIncome = { month, amount: Math.round((need * m.get(user)) / total / 1000) * 1000 };
    break;
  }

  return {
    targetMonth: addMonth(thisMonth, 1),
    fixed: { total: fixedTotal, items: fixedItems },
    variable: { average, months, basis },
    raw,
    need,
    half: need / 2,
    byIncome: need > 0 ? byIncome : null,
  };
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

// --- グラフ(「グラフ」のタブ) -----------------------------------------------------
//
// どのグラフも、切り替え(scope)で選んだ財布1つだけを数える。
//   "self"  … 財布が自分の記録
//   "joint" … 財布が共同口座の記録
// 相手の財布の記録は、どこにも混ぜない。ただし共同口座の「入金」の目印だけは、2人の「共同へ入金」の合計
// (共同口座の動きなので、2人とも見える。仕様書 3章)。
// 支出の決まりは「見る」と同じ: 変動費 + 特別費 + 固定費(SPEND_KINDS)。貯蓄・収入・税金・共同へ入金は、支出に入れない。

/** グラフの切り替え */
export const CHART_SCOPE = Object.freeze({ SELF: "self", JOINT: "joint" });

/** 月ごとの推移に、何か月ぶん出すか */
export const CHART_MONTHS = 6;

/** うちわけで、名前を出すカテゴリの数(それより下は「その他」にまとめる) */
export const CHART_TOP = 5;

/** まとめたカテゴリの呼び名 */
export const OTHER_CATEGORY = "その他";

function scopeWallet(user, scope) {
  return scope === CHART_SCOPE.JOINT ? WALLET_JOINT : user;
}

/** 記録の日にち(1〜31)。日付が読めない記録は、月の1日として数える(月は「月」の列で決まっているので) */
function dayOf(record) {
  const date = String(record["日付"] || "");
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? Number(date.slice(8, 10)) : 1;
}

/**
 * 月ごとの推移(積み上げ棒)。
 *
 *   出す月: 記録のある月のうち、新しいほうから count か月(切り替えられる月の範囲 monthRange と同じ端)。
 *           選んでいる月がそれより古いときは、選んでいる月を左端にして count か月。
 *           記録を始めた月より前は出さない(はじめのうちは、count か月に満たない)。
 *   段    : 変動費 / 固定費 / 特別費(その財布の分だけ)。total = 3つの合計 =「見る」の支出・合計と同じ金額。
 *   目印  : 自分 → その月に確定した自分の収入(手取り)の合計。共同口座 → その月の「共同へ入金」の合計(2人分)。
 *           無い月は 0(目印を出さない)。over = 目印があって、支出がそれを超えた月。
 *
 * @param {object[]} records 記録(未送信の分を重ねたもの)
 * @param {string} user      この iPhone の持ち主
 * @param {"self"|"joint"} scope
 * @param {{selected: string, thisMonth: string, count?: number}} opt
 * @returns {{months: {month: string, variable: number, fixed: number, special: number, total: number, marker: number, over: boolean}[],
 *            markerKind: "income"|"deposit", max: number}} max = 棒と目印の、いちばん高い金額
 */
export function chartTrend(records, user, scope, { selected, thisMonth, count = CHART_MONTHS }) {
  const wallet = scopeWallet(user, scope);
  const joint = scope === CHART_SCOPE.JOINT;
  const range = monthRange(records, user, thisMonth);
  let end = range.max;
  let start = addMonth(end, -(count - 1));
  if (selected && selected < start) {
    start = selected;
    end = addMonth(start, count - 1);
  }
  if (start < range.min && !(selected && selected < range.min)) start = range.min;

  const map = new Map();
  for (let month = start; month <= end; month = addMonth(month, 1)) {
    map.set(month, { month, variable: 0, fixed: 0, special: 0, total: 0, marker: 0, over: false });
  }
  for (const r of records) {
    if (!r) continue;
    const entry = map.get(recordMonth(r));
    if (!entry) continue;
    const amount = amountOf(r);
    const kind = r["種類"];
    if (r["財布"] === wallet) {
      if (kind === KIND.VARIABLE) entry.variable += amount;
      else if (kind === MONTHLY.FIXED) entry.fixed += amount;
      else if (kind === KIND.SPECIAL) entry.special += amount;
    }
    if (joint ? kind === KIND.DEPOSIT : r["財布"] === user && kind === MONTHLY.INCOME) entry.marker += amount;
  }
  let max = 0;
  const months = Array.from(map.values());
  for (const entry of months) {
    entry.total = entry.variable + entry.fixed + entry.special;
    entry.over = entry.marker > 0 && entry.total > entry.marker;
    max = Math.max(max, entry.total, entry.marker);
  }
  return { months, markerKind: joint ? "deposit" : "income", max };
}

/** 割合(%)を、合わせて 100 になるように整数にする(端数の大きい順に 1 ずつ足す) */
function percents(amounts, total) {
  if (!(total > 0)) return amounts.map(() => 0);
  const raw = amounts.map((a) => (a / total) * 100);
  const out = raw.map(Math.floor);
  let rest = 100 - out.reduce((sum, n) => sum + n, 0);
  const order = raw.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < order.length && rest > 0; k++, rest--) out[order[k].i] += 1;
  return out;
}

/**
 * この月のうちわけ(ドーナツ)。その財布の、変動費のカテゴリ別。
 *
 *   - 金額の大きい順(同じ金額なら、先に出てきた順)。0円のカテゴリは出さない。
 *   - 上位 top 個までは名前で出し、それより下は「その他」1つにまとめる(色の数を抑えるため)。
 *     まとめる相手が1つだけのとき(カテゴリが top+1 個)は、まとめずにそのまま出す(数は同じなので)。
 *   - percent は整数で、合わせて 100。
 *   - 固定費・特別費はドーナツに混ぜず、合計だけ返す(下に小さく添える)。spend = 変動費+固定費+特別費。
 *
 * @returns {{month: string, total: number, slices: {name: string, amount: number, percent: number, other: boolean, count: number}[],
 *            fixed: number, special: number, spend: number}} total = 変動費の合計。count = まとめたカテゴリの数(ふつうは 1)
 */
export function chartBreakdown(records, user, scope, month, top = CHART_TOP) {
  const wallet = scopeWallet(user, scope);
  const categoryMap = new Map();
  let fixed = 0;
  let special = 0;
  for (const r of records) {
    if (!r || r["財布"] !== wallet || recordMonth(r) !== month) continue;
    const amount = amountOf(r);
    if (r["種類"] === KIND.VARIABLE) {
      const name = String(r["項目"] || "").trim() || NO_CATEGORY;
      categoryMap.set(name, (categoryMap.get(name) || 0) + amount);
    } else if (r["種類"] === MONTHLY.FIXED) {
      fixed += amount;
    } else if (r["種類"] === KIND.SPECIAL) {
      special += amount;
    }
  }
  const sorted = Array.from(categoryMap, ([name, amount]) => ({ name, amount }))
    .filter((c) => c.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  let slices = sorted.map((c) => ({ ...c, percent: 0, other: false, count: 1 }));
  if (sorted.length > top + 1) {
    const rest = sorted.slice(top);
    slices = slices.slice(0, top);
    slices.push({
      name: OTHER_CATEGORY,
      amount: rest.reduce((sum, c) => sum + c.amount, 0),
      percent: 0,
      other: true,
      count: rest.length,
    });
  }
  const total = slices.reduce((sum, s) => sum + s.amount, 0);
  const pct = percents(slices.map((s) => s.amount), total);
  slices.forEach((s, i) => {
    s.percent = pct[i];
  });
  return { month, total, slices, fixed, special, spend: total + fixed + special };
}

/** その月の変動費の、日ごとの累計(その財布の分)。daily[d-1] = d 日までの合計 */
function cumulativeByDay(records, wallet, month) {
  const days = daysInMonth(month);
  const perDay = new Array(days).fill(0);
  let lastRecordDay = 0;
  for (const r of records) {
    if (!r || r["財布"] !== wallet || r["種類"] !== KIND.VARIABLE || recordMonth(r) !== month) continue;
    const amount = amountOf(r);
    if (amount === 0) continue;
    const day = Math.min(days, Math.max(1, dayOf(r)));
    perDay[day - 1] += amount;
    if (day > lastRecordDay) lastRecordDay = day;
  }
  const daily = [];
  let sum = 0;
  for (const amount of perDay) {
    sum += amount;
    daily.push(sum);
  }
  return { days, daily, total: sum, lastRecordDay };
}

/**
 * 使ったペース(折れ線)。その月の変動費の、日ごとの累計と、前の月の累計。
 *
 *   - 日にちは記録の 日付(お金が動いた日)。フォームから取り込んだ記録も、日付の列のまま。
 *   - lastDay = 線を引く最後の日。今月なら、きょう(きょうより先の日付の記録があれば、その日)まで。
 *     過ぎた月・先の月は、月末まで。
 *   - toDate = lastDay までの累計。
 *   - prev = 前の月(その財布の変動費が1件もなければ null)。sameDay = 前の月の、同じ日にち(lastDay)までの累計
 *     (前の月のほうが短いときは、前の月の月末まで)。
 *
 * @param {string} today きょう 'YYYY-MM-DD'
 * @returns {{month: string, days: number, lastDay: number, daily: number[], total: number, toDate: number, isCurrent: boolean,
 *            prev: {month: string, days: number, daily: number[], total: number, sameDay: number} | null}}
 */
export function chartPace(records, user, scope, month, today) {
  const wallet = scopeWallet(user, scope);
  const current = cumulativeByDay(records, wallet, month);
  const isCurrent = month === today.slice(0, 7);
  const lastDay = isCurrent
    ? Math.min(current.days, Math.max(Number(today.slice(8, 10)) || 1, current.lastRecordDay))
    : current.days;
  const prevMonth = addMonth(month, -1);
  const before = cumulativeByDay(records, wallet, prevMonth);
  return {
    month,
    days: current.days,
    lastDay,
    daily: current.daily,
    total: current.total,
    toDate: current.daily[lastDay - 1],
    isCurrent,
    prev:
      before.total > 0
        ? {
            month: prevMonth,
            days: before.days,
            daily: before.daily,
            total: before.total,
            sameDay: before.daily[Math.min(lastDay, before.days) - 1],
          }
        : null,
  };
}
