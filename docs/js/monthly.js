// 「毎月の設定」画面(仕様書 4.3)。月に1回、収入・税金・固定費・貯蓄を入れて「確定」する。
//
//   - 出すのは、自分の項目と共同口座の項目だけ(相手の収入・税金・固定費・貯蓄は出さない)。
//   - 金額の「もとの値」は、確定した記録 → (未確定の月は)登録してある金額、の順で決まる(summary.js の monthlyBase)。
//     入力し直した分だけを「下書き」として端末に覚えておく(確定するまで消えない。月ごと・人ごと)。
//   - 確定と、項目の追加・変更・停止は、その場で保存先に送る(月1回の画面なので、電波のあるところで使う前提)。
//     失敗しても入力は消えない。もういちど押せば送り直せる。
//   - 保存先(GAS)が古い版のあいだは、「保存先の更新が必要にゃ」と出すだけで、何も送らない。
//   - 行の金額は「今月だけ」の値。「毎月の金額」を変えるときは、なまえを押して項目をなおす。
//   - 共同口座の項目は2人で共通(あとから確定した人の値になる)。ただし、自分がさわっていない金額は送らない
//     (相手が入れた金額を、この端末の古い内容で書きもどさないため)。

import { ApiError, addMonthlyItem, closeMonth, updateMonthlyItem } from "./api.js";
import { WALLET_JOINT } from "./config.js";
import { createSlot } from "./photos.js";
import * as queue from "./queue.js";
import * as store from "./store.js";
import { MONTHLY, addMonth, applyQueue, autoRecordMap, closedBy, monthRange, monthlyBase, monthlyItemsFor } from "./summary.js";
import { digitsOnly, formatAmount, todayString } from "./util.js";

const MAX_AMOUNT_DIGITS = 8; // 保存先の上限(99,999,999円)と同じ
const MAX_NAME_LENGTH = 30;  // 保存先の上限と同じ

const LINE = Object.freeze({
  loading: "さいしんの内容を、よみこみ中にゃ…",
  loadFailed: "まだ読みこめていないにゃ。電波のよいところで、もういちど開いてみてね。",
  needUpdate: "保存先の更新が必要にゃ。",
  needUpdateNote: "スプレッドシートの Apps Script を新しい版にすると、この画面が使えるようになります。入力と「見る」は、いままでどおり使えます。",
  closing: "確定しています…",
  closed: (m) => `${m}月分を確定したにゃ。「見る」にも入ったにゃ。`,
  network: "いまは保存先に届かなかったにゃ。入力はそのまま残してあるので、電波のよいところで、もういちど押してね。",
  busy: "保存先が混みあっているにゃ。少し待って、もういちど押してね。",
  locked: "少し時間をおいてにゃ。合言葉のまちがいが続いたので、10分ほどお休みしています。",
  forbidden: "この項目は、ここからはなおせないにゃ。さいしんの内容を読みこみ直すので、もういちど見てみてね。",
  failed: "うまく保存できなかったにゃ。入力はそのまま残してあるので、少し待って、もういちど押してね。",
  storage: "この iPhone に下書きを書きこめなかったにゃ…。空き容量や、プライベートブラウズになっていないかを見てみてね。",
  needName: "なまえを入れてにゃ。",
  sameName: "同じなまえの項目が、もうあるにゃ。",
  added: (name) => `「${name}」を足したにゃ。`,
  revived: (name) => `止めていた「${name}」を、もういちど出すようにしたにゃ。`,
  updated: (name) => `「${name}」をなおしたにゃ。`,
  stopped: (name) => `「${name}」を止めたにゃ。次の月から出なくなるにゃ(これまでの記録は残るにゃ)。`,
});

/** 追加のときに選ぶ「どこに足すか」 */
const GROUPS = Object.freeze([
  { key: "joint-fixed", joint: true, kind: MONTHLY.FIXED, label: () => "共同口座の固定費" },
  { key: "self-fixed", joint: false, kind: MONTHLY.FIXED, label: (user) => `${user}の固定費` },
  { key: "self-saving", joint: false, kind: MONTHLY.SAVING, label: (user) => `${user}の貯蓄` },
  { key: "self-income", joint: false, kind: MONTHLY.INCOME, label: (user) => `${user}の収入` },
  { key: "self-tax", joint: false, kind: MONTHLY.TAX, label: () => "税金・社会保険" },
]);

const $ = (id) => document.getElementById(id);

const el = {
  view: $("view-monthly"),
  prev: $("monthly-prev"),
  next: $("monthly-next"),
  title: $("monthly-title"),
  screen: $("screen"),
  notice: $("monthly-notice"),
  noticeGoma: $("monthly-notice-goma"),
  noticeText: $("monthly-notice-text"),
  wait: $("monthly-wait"),
  waitText: $("monthly-wait-text"),
  waitNote: $("monthly-wait-note"),
  body: $("monthly-body"),
  incomeTitle: $("monthly-income-title"),
  income: $("monthly-income"),
  taxToggle: $("monthly-tax-toggle"),
  taxBox: $("monthly-tax-box"),
  tax: $("monthly-tax"),
  fixed: $("monthly-fixed"),
  status: $("monthly-status"),
  submit: $("monthly-submit"),
  submitText: $("monthly-submit-text"),
  // 項目の追加・変更
  dialog: $("item-dialog"),
  form: $("item-form"),
  dialogTitle: $("item-title"),
  fieldGroup: $("item-field-group"),
  groups: $("item-groups"),
  groupText: $("item-group-text"),
  name: $("item-name"),
  fieldVaries: $("item-field-varies"),
  varies: Array.from(document.querySelectorAll("#item-varies .choice")),
  fieldAmount: $("item-field-amount"),
  amountBox: $("item-amount-box"),
  amount: $("item-amount"),
  error: $("item-error"),
  cancel: $("item-cancel"),
  save: $("item-save"),
  stop: $("item-stop"),
  stopNote: $("item-stop-note"),
};

const state = {
  user: "",
  month: "",          // 見ている月 'YYYY-MM'
  nextMonth: "",      // つぎに開くときに出す月(「見る」の明細から来たとき)
  edits: new Map(),   // 入力し直した金額(項目の id → 数字だけの文字。空文字 = 消した)。= 下書き
  rows: new Map(),    // 画面に出している行(項目の id → { item, base, row, input, sub })
  sync: "idle",       // 裏での取得: "idle" | "loading" | "ok" | "error"
  busy: false,        // 確定を送っている最中
  stale: false,       // 入力中に新しいデータが届いた(入力が終わったら出しなおす)
  taxOpen: null,      // 税金の欄を開いているか(null = まだ決めていない)
  dialog: null,       // 項目の追加・変更の内容 { mode: "add"|"edit", item, group, varies, stopArmed, busy }
};

let hooks = { applyServerData() {}, onAuthLost() {}, requestSync() {} };

// --- 小さな道具 -------------------------------------------------------------

function yen(amount) {
  return `¥${formatAmount(amount)}`;
}

function monthNumber(month) {
  return Number(month.split("-")[1]);
}

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

function isShown() {
  return !el.view.hidden;
}

/** 上の一言。hesoten = true で、へそ天のごまちゃんを添える(月を確定できたとき) */
function setNotice(text, tone = "", hesoten = false) {
  el.notice.hidden = !text;
  el.noticeText.textContent = text || "";
  el.noticeGoma.hidden = !(text && hesoten);
  if (tone) {
    el.notice.dataset.tone = tone;
  } else {
    delete el.notice.dataset.tone;
  }
}

/** '2026-11-13 16:20:30' → '11/13 16:20' */
function shortDateTime(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(text || ""));
  return m ? `${Number(m[2])}/${Number(m[3])} ${m[4]}:${m[5]}` : String(text || "");
}

/** 失敗の理由を、やさしい言葉にする */
function messageFor(err) {
  const code = err instanceof ApiError ? err.code : "unknown";
  switch (code) {
    case "unknown_action":
      return `${LINE.needUpdate}${LINE.needUpdateNote}`;
    case "network":
    case "not_configured":
      return LINE.network;
    case "busy":
      return LINE.busy;
    case "locked":
      return LINE.locked;
    case "forbidden":
      return LINE.forbidden;
    default:
      return LINE.failed;
  }
}

/** 通信の失敗の、共通のあとしまつ。合言葉が通らなくなっていたら、入れ直しの画面へ */
function handleFailure(err) {
  const code = err instanceof ApiError ? err.code : "unknown";
  if (code === "auth") {
    hooks.onAuthLost();
    return true;
  }
  if (code === "unknown_action") {
    // 保存先が古い版だった。覚えておいて、画面を「更新が必要」に切り替える
    store.setMonthlyReady(false);
  } else if (code === "forbidden" || code === "invalid") {
    hooks.requestSync(); // 端末の内容が古いのかもしれない。取り直す
  }
  return false;
}

// --- データ -----------------------------------------------------------------

/** いまの月の、画面に出す材料をそろえる */
function gather() {
  const user = state.user;
  const { records } = applyQueue(store.getRecords(), queue.pendingOps(), user);
  const autoMap = autoRecordMap(records, state.month);
  const closedMap = closedBy(store.getMonthlyClosed(), state.month);
  const items = monthlyItemsFor(store.getMonthlyItems(), user, autoMap);
  return { records, autoMap, closedMap, items };
}

function valueOf(id) {
  if (state.edits.has(id)) return state.edits.get(id);
  const entry = state.rows.get(id);
  return entry ? entry.base : "";
}

function loadDraft() {
  state.edits = new Map(Object.entries(store.getMonthlyDraft(state.user, state.month)).map(([id, v]) => [id, digitsOnly(v)]));
}

function saveDraft() {
  return store.setMonthlyDraft(state.user, state.month, Object.fromEntries(state.edits));
}

/** もとの値と同じになった入力は、下書きから外す。画面に無い項目の下書きも捨てる */
function pruneEdits() {
  let changed = false;
  for (const [id, value] of Array.from(state.edits)) {
    const entry = state.rows.get(id);
    if (!entry || entry.base === value) {
      state.edits.delete(id);
      changed = true;
    }
  }
  if (changed) saveDraft();
}

// --- 表示 -------------------------------------------------------------------

/** 行の見た目を、いまの値に合わせる(入力中の文字には、さわらない) */
function paintRow(entry) {
  const { item, row, sub } = entry;
  const value = valueOf(item.id);
  row.toggleAttribute("data-filled", value !== "");
  row.toggleAttribute("data-edited", state.edits.has(item.id));
  // 金額が入っている欄は、数字の幅だけにする(肉球と ¥ を、数字のすぐ左に並べるため)
  const text = entry.input.value;
  const commas = text.split(",").length - 1;
  entry.input.style.width = value !== "" ? `calc(${text.length - commas}ch + ${commas} * 0.5ch + 4px)` : "";

  const autoFill = (item["区分"] === MONTHLY.FIXED || item["区分"] === MONTHLY.SAVING) && item["毎月かわる"] !== true;
  const registered = Number(item["金額"]) || 0;
  const notes = [];
  if (item["有効"] !== true) notes.push("停止中");
  if ((item["区分"] === MONTHLY.FIXED || item["区分"] === MONTHLY.SAVING) && item["毎月かわる"] === true) notes.push("毎月かわる");
  if (autoFill && registered > 0 && value !== String(registered)) notes.push(`いつもは ${yen(registered)}`);
  sub.textContent = notes.join("・");
  sub.hidden = notes.length === 0;
}

/** 1行を作る。variant: "big"(収入が1つだけのときの大きな欄) | "optional"(税金。空でよい) | "" */
function buildRow(item, base, variant) {
  const row = node("div", "mrow");
  if (variant) row.classList.add(`mrow--${variant}`);
  row.dataset.id = item.id;

  const name = node("button", "mrow__name");
  name.type = "button";
  name.dataset.edit = item.id;
  name.setAttribute("aria-label", `${item["項目名"]}の項目をなおす`);
  const sub = node("span", "mrow__sub");
  name.append(node("span", "mrow__label", item["項目名"]), sub);

  const box = node("label", "mrow__amount");
  box.insertAdjacentHTML(
    "afterbegin",
    '<svg class="mrow__paw" aria-hidden="true" width="16" height="16" fill="currentColor"><use href="#i-paw"></use></svg>' +
      '<span class="mrow__yen" aria-hidden="true">¥</span>'
  );
  const input = node("input", "mrow__input");
  input.type = "text";
  input.inputMode = "numeric";
  input.setAttribute("inputmode", "numeric");
  input.setAttribute("pattern", "[0-9,]*");
  input.autocomplete = "off";
  input.setAttribute("enterkeyhint", "done");
  input.maxLength = 10;
  input.placeholder = variant === "big" ? "0" : variant === "optional" ? "あれば入れる" : "金額を入れる";
  input.setAttribute("aria-label", `${item["項目名"]}の金額`);
  input.dataset.id = item.id;
  box.append(input);

  row.append(name, box);
  const entry = { item, base, row, input, sub };
  state.rows.set(item.id, entry);
  const value = valueOf(item.id);
  input.value = value ? formatAmount(Number(value)) : "";
  paintRow(entry);
  return row;
}

function groupHead(title, key) {
  const head = node("div", "mgroup");
  head.append(node("span", "", title));
  const sum = node("span", "mgroup__sum");
  sum.dataset.sum = key;
  head.append(sum);
  return head;
}

function sumOf(items) {
  return items.reduce((total, item) => total + (Number(valueOf(item.id)) || 0), 0);
}

/** 合計・確定のようす・ボタンの文字など、入力のたびに変わるところ */
function paintStatus() {
  const { closedMap, items } = state.shown;
  const m = monthNumber(state.month);
  const user = state.user;

  for (const span of el.view.querySelectorAll("[data-sum]")) {
    const group = state.shown.groups[span.dataset.sum] || [];
    const total = sumOf(group);
    span.textContent = total > 0 ? yen(total) : "";
  }

  const dirty = state.edits.size > 0;
  const mine = closedMap.get(user);
  const lines = [];
  let tone = "";
  if (mine && !dirty) {
    lines.push(`${m}月分は確定済みにゃ（${shortDateTime(mine)}）`);
  } else if (mine && dirty) {
    lines.push(`なおした内容は、まだ確定していないにゃ（前の確定: ${shortDateTime(mine)}）`);
    tone = "warn";
  } else {
    lines.push(`${m}月分は、まだ確定していないにゃ`);
    tone = "warn";
  }
  for (const [name, at] of closedMap) {
    if (name !== user) lines.push(`${name}は確定済み（${shortDateTime(at)}）`);
  }
  const empty = items.filter(
    (item) => (item["区分"] === MONTHLY.FIXED || item["区分"] === MONTHLY.SAVING) && item["有効"] === true && valueOf(item.id) === ""
  ).length;
  if (empty > 0) lines.push(`金額が空の項目が ${empty}つあるにゃ（空のままでも確定できます。あとで入れて、確定し直せます）`);
  el.status.textContent = lines.join("\n");
  if (tone) {
    el.status.dataset.tone = tone;
  } else {
    delete el.status.dataset.tone;
  }

  el.submit.disabled = state.busy;
  el.submitText.textContent = state.busy ? LINE.closing : mine && !dirty ? `${m}月分を確定し直す` : `${m}月分を確定する`;
}

/** 画面全体を、いまのデータで作りなおす */
function render() {
  const user = store.getUser();
  if (!user) return;
  const thisMonth = todayString().slice(0, 7);
  if (state.user !== user) {
    // 持ち主が変わった(登録し直した)ら、最初の状態に戻す
    state.user = user;
    state.month = thisMonth;
    state.taxOpen = null;
    closeDialog();
    loadDraft();
  }
  state.stale = false;

  // 月の範囲: 記録のある最古の月(なければ先月)〜 来月
  const all = applyQueue(store.getRecords(), queue.pendingOps(), user).records;
  const min = [monthRange(all, user, thisMonth).min, addMonth(thisMonth, -1)].sort()[0];
  const max = addMonth(thisMonth, 1);
  if (!state.month || state.month < min) state.month = min;
  if (state.month > max) state.month = max;
  const m = monthNumber(state.month);
  const [y] = state.month.split("-");
  el.title.textContent = `${y}年${m}月`;
  el.prev.disabled = state.month <= min || state.busy;
  el.next.disabled = state.month >= max || state.busy;

  // 保存先が古い版・まだ読みこめていない
  const ready = store.getMonthlyReady();
  let waitText = "";
  let waitNote = "";
  if (ready === false) {
    waitText = LINE.needUpdate;
    waitNote = LINE.needUpdateNote;
    setNotice(""); // 同じ内容を2回出さない
  } else if (ready === null) {
    waitText = state.sync === "error" ? LINE.loadFailed : LINE.loading;
  }
  el.wait.hidden = !waitText;
  el.waitText.textContent = waitText;
  el.waitNote.textContent = waitNote;
  el.waitNote.hidden = !waitNote;
  el.body.hidden = Boolean(waitText);
  if (waitText) return;

  const { autoMap, closedMap, items } = gather();
  state.rows = new Map();
  const of = (kind, joint) => items.filter((item) => item["区分"] === kind && (item["持ち主"] === WALLET_JOINT) === joint);
  const groups = {
    income: of(MONTHLY.INCOME, false),
    tax: of(MONTHLY.TAX, false),
    jointFixed: of(MONTHLY.FIXED, true),
    selfFixed: of(MONTHLY.FIXED, false),
    saving: of(MONTHLY.SAVING, false),
  };
  state.shown = { autoMap, closedMap, items, groups };
  const base = (item) => monthlyBase(item, autoMap, closedMap, user);

  // 収入(手取り)。1つだけなら見本どおりの大きな欄、複数なら1行ずつ
  el.incomeTitle.textContent = `${m}月の収入（手取り）`;
  el.income.textContent = "";
  const single = groups.income.length === 1;
  for (const item of groups.income) el.income.append(buildRow(item, base(item), single ? "big" : ""));
  if (groups.income.length > 1) {
    const total = node("div", "mgroup mgroup--total");
    total.append(node("span", "", "手取りの合計"));
    const sum = node("span", "mgroup__sum");
    sum.dataset.sum = "income";
    total.append(sum);
    el.income.append(total);
  }
  if (groups.income.length === 0) el.income.append(node("p", "mcard__none", "収入の項目がないにゃ。「追加」から足せます。"));

  // 税金・社会保険(任意。入っていれば開いておく)
  el.tax.textContent = "";
  for (const item of groups.tax) el.tax.append(buildRow(item, base(item), "optional"));
  if (state.taxOpen === null) state.taxOpen = groups.tax.some((item) => valueOf(item.id) !== "");
  paintTax();

  // 固定費と貯蓄
  el.fixed.textContent = "";
  const section = (title, key, list, none, note) => {
    el.fixed.append(groupHead(title, key));
    if (note && list.length > 0) el.fixed.append(node("p", "mgroup__note", note));
    for (const item of list) el.fixed.append(buildRow(item, base(item), ""));
    if (list.length === 0) el.fixed.append(node("p", "mcard__none", none));
  };
  section(
    "共同口座",
    "jointFixed",
    groups.jointFixed,
    "共同口座の固定費は、まだないにゃ。",
    "2人で共通の金額です（自分の負担分ではなく、全体の金額）。なおすと、相手の画面でも変わります。"
  );
  section(user, "selfFixed", groups.selfFixed, `${user}の固定費は、まだないにゃ。`);
  section("貯蓄（貯めたお金）", "saving", groups.saving, "貯蓄の項目は、まだないにゃ。");

  pruneEdits();
  for (const entry of state.rows.values()) paintRow(entry);
  paintStatus();
}

function paintTax() {
  const open = Boolean(state.taxOpen);
  el.taxBox.hidden = !open;
  el.taxToggle.setAttribute("aria-expanded", open ? "true" : "false");
  el.taxToggle.textContent = open ? "税金・社会保険をとじる" : "税金・社会保険も入れる";
}

// --- 操作: 金額の入力 --------------------------------------------------------

function onAmountInput(input) {
  const entry = state.rows.get(input.dataset.id);
  if (!entry) return;
  const digits = digitsOnly(input.value).slice(0, MAX_AMOUNT_DIGITS);
  input.value = digits ? formatAmount(Number(digits)) : "";
  if (digits === entry.base) {
    state.edits.delete(entry.item.id);
  } else {
    state.edits.set(entry.item.id, digits);
  }
  if (!saveDraft()) setNotice(LINE.storage, "warn");
  paintRow(entry);
  paintStatus();
}

function moveMonth(delta) {
  if (state.busy) return;
  state.month = addMonth(state.month, delta);
  state.taxOpen = null;
  setNotice("");
  loadDraft();
  render();
}

// --- 操作: 確定 --------------------------------------------------------------

async function submit() {
  if (state.busy || !state.shown) return;
  const month = state.month;
  const user = state.user;
  const amounts = {};
  const removes = [];
  for (const item of state.shown.items) {
    const amount = Number(valueOf(item.id)) || 0;
    // 共同口座の項目で、自分は金額をさわっていないもの: すでに記録があれば、送らない(保存先にある金額のままにする)。
    // この端末の内容が古いと、相手があとから入れ直した金額を、古い金額で書きもどしてしまうため。
    // 記録の財布・種類・なまえが項目とちがうとき(シートで持ち主を書きかえた等)は、いままでどおり送って、そろえる
    const record = state.shown.autoMap.get(item.id);
    if (
      item["持ち主"] === WALLET_JOINT &&
      !state.edits.has(item.id) &&
      record &&
      record["財布"] === item["持ち主"] &&
      record["種類"] === item["区分"] &&
      record["項目"] === item["項目名"]
    ) {
      continue;
    }
    if (amount > 0) {
      amounts[item.id] = amount;
    } else if (item["持ち主"] === user || state.shown.autoMap.has(item.id)) {
      // 空にした項目は、その月の記録を消す。
      // 共同口座の項目は、記録があるのを見たうえで空にしたときだけ(知らないうちに相手の入力を消さない)
      removes.push(item.id);
    }
  }

  let closed = false;
  state.busy = true;
  setNotice("");
  paintStatus();
  el.prev.disabled = true;
  el.next.disabled = true;
  try {
    const result = await closeMonth(month, amounts, removes);
    if (store.getUser() !== user) return; // 送っているあいだに登録がやり直された
    hooks.applyServerData(result);
    store.setMonthlyDraft(user, month, null);
    if (state.month === month) state.edits = new Map();
    setNotice(LINE.closed(monthNumber(month)), "", true);
    closed = true;
  } catch (err) {
    if (handleFailure(err)) return;
    setNotice(messageFor(err), "warn");
  } finally {
    state.busy = false;
    if (isShown()) {
      render();
      // 確定できたら、上の一言(へそ天のごまちゃん)が見えるところまで戻す
      if (closed) el.screen.scrollTo({ top: 0, behavior: "smooth" });
    }
  }
}

// --- 操作: 項目の追加・変更・停止 --------------------------------------------

function showItemError(text) {
  el.error.hidden = !text;
  el.error.textContent = text || "";
}

function setItemAmount(text) {
  const digits = digitsOnly(text).slice(0, MAX_AMOUNT_DIGITS);
  el.amount.value = digits ? formatAmount(Number(digits)) : "";
}

function paintDialog() {
  const d = state.dialog;
  if (!d) return;
  const group = d.group;
  const hasAmount = group.kind === MONTHLY.FIXED || group.kind === MONTHLY.SAVING;
  for (const button of el.groups.children) {
    button.setAttribute("aria-pressed", button.dataset.group === group.key ? "true" : "false");
  }
  el.fieldVaries.hidden = !hasAmount;
  el.fieldAmount.hidden = !hasAmount || d.varies;
  for (const button of el.varies) {
    button.setAttribute("aria-pressed", (button.dataset.varies === "true") === d.varies ? "true" : "false");
  }
  el.save.disabled = d.busy;
  el.cancel.disabled = d.busy;
  el.stop.disabled = d.busy;
  el.save.textContent = d.busy ? "送っています…" : d.mode === "add" ? "追加する" : "なおす";
  el.stop.textContent = d.stopArmed ? "ほんとうに停止する" : "この項目を停止する";
}

function openDialog(mode, groupKey, item) {
  if (state.busy) return;
  const user = state.user;
  let group;
  if (mode === "edit") {
    group = GROUPS.find((g) => g.kind === item["区分"] && g.joint === (item["持ち主"] === WALLET_JOINT));
    if (!group) return;
  } else {
    group = GROUPS.find((g) => g.key === groupKey) || GROUPS[0];
  }
  state.dialog = { mode, item: item || null, group, varies: item ? item["毎月かわる"] === true : false, stopArmed: false, busy: false };

  el.dialogTitle.textContent = mode === "add" ? "項目を追加" : "項目をなおす";
  el.fieldGroup.hidden = mode !== "add";
  el.groupText.hidden = mode === "add";
  el.groupText.textContent = group.label(user);
  el.groups.textContent = "";
  if (mode === "add") {
    for (const g of GROUPS) {
      const button = node("button", "choice choice--small", g.label(user));
      button.type = "button";
      button.dataset.group = g.key;
      el.groups.append(button);
    }
  }
  el.name.value = item ? item["項目名"] : "";
  el.name.removeAttribute("data-invalid");
  setItemAmount(item && item["金額"] ? String(item["金額"]) : "");
  const stoppable = mode === "edit" && item["有効"] === true;
  el.stop.hidden = !stoppable;
  el.stopNote.hidden = !stoppable;
  showItemError("");
  paintDialog();
  el.dialog.hidden = false;
  if (mode === "add") el.name.focus();
}

function closeDialog() {
  state.dialog = null;
  el.dialog.hidden = true;
}

/** 保存先から返ってきた最新の内容を受け取って、画面を出しなおす */
function afterItemChange(result, text) {
  hooks.applyServerData(result);
  closeDialog();
  setNotice(text);
  render();
}

/** この月の金額の欄にも、新しい「毎月の金額」を入れておく(下書きとして。確定するまで保存先には入らない) */
function fillThisMonth(id, amount, oldAmount = 0) {
  if (!(amount > 0)) return;
  // すでに記録のある月(確定済み)や、今月だけ別の金額を打ってある欄は、変えない
  if (state.shown && state.shown.autoMap.has(id)) return;
  const current = valueOf(id);
  if (current !== "" && current !== String(oldAmount)) return;
  state.edits.set(id, String(amount));
  saveDraft();
}

async function saveItem(event) {
  event.preventDefault();
  const d = state.dialog;
  if (!d || d.busy) return;
  const user = state.user;
  const group = d.group;
  const owner = group.joint ? WALLET_JOINT : user;
  const name = el.name.value.trim();
  if (!name) {
    el.name.setAttribute("data-invalid", "true");
    showItemError(LINE.needName);
    el.name.focus();
    return;
  }
  const hasAmount = group.kind === MONTHLY.FIXED || group.kind === MONTHLY.SAVING;
  const varies = hasAmount && d.varies;
  const amount = hasAmount && !varies ? Number(digitsOnly(el.amount.value)) || 0 : 0;
  // 同じなまえの項目が、もう出ているとき
  const clash = store
    .getMonthlyItems()
    .some(
      (it) => it["有効"] === true && it["持ち主"] === owner && it["区分"] === group.kind && it["項目名"] === name && (!d.item || it.id !== d.item.id)
    );
  if (clash) {
    el.name.setAttribute("data-invalid", "true");
    showItemError(LINE.sameName);
    return;
  }

  d.busy = true;
  showItemError("");
  paintDialog();
  try {
    if (d.mode === "add") {
      const result = await addMonthlyItem({ 持ち主: owner, 区分: group.kind, 項目名: name, 金額: amount || null, 毎月かわる: varies });
      if (store.getUser() !== user) return;
      if (hasAmount && !varies) fillThisMonth(result.id, amount);
      afterItemChange(result, result.revived ? LINE.revived(name) : LINE.added(name));
    } else {
      const item = d.item;
      const patch = {};
      if (name !== item["項目名"]) patch["項目名"] = name;
      if (hasAmount) {
        if (varies !== (item["毎月かわる"] === true)) patch["毎月かわる"] = varies;
        if (amount !== (Number(item["金額"]) || 0)) patch["金額"] = amount || null;
      }
      if (Object.keys(patch).length === 0) {
        closeDialog();
        return;
      }
      const result = await updateMonthlyItem(item.id, patch);
      if (store.getUser() !== user) return;
      if (hasAmount && !varies && "金額" in patch) fillThisMonth(item.id, amount, Number(item["金額"]) || 0);
      afterItemChange(result, LINE.updated(name));
    }
  } catch (err) {
    if (handleFailure(err)) return;
    const data = err instanceof ApiError ? err.data : null;
    showItemError(data && data.field === "項目名" ? (data.reason === "duplicate" ? LINE.sameName : LINE.needName) : messageFor(err));
    if (store.getMonthlyReady() === false) {
      closeDialog();
      render();
    }
  } finally {
    if (state.dialog === d) {
      d.busy = false;
      paintDialog();
    }
  }
}

async function stopItem() {
  const d = state.dialog;
  if (!d || d.busy || d.mode !== "edit") return;
  if (!d.stopArmed) {
    d.stopArmed = true; // 1回目は、たしかめるだけ
    paintDialog();
    return;
  }
  const user = state.user;
  d.busy = true;
  showItemError("");
  paintDialog();
  try {
    const result = await updateMonthlyItem(d.item.id, { 有効: false });
    if (store.getUser() !== user) return;
    afterItemChange(result, LINE.stopped(d.item["項目名"]));
  } catch (err) {
    if (handleFailure(err)) return;
    showItemError(messageFor(err));
    if (store.getMonthlyReady() === false) {
      closeDialog();
      render();
    }
  } finally {
    if (state.dialog === d) {
      d.busy = false;
      paintDialog();
    }
  }
}

// --- 外から呼ぶもの ---------------------------------------------------------

/** 見出しの写真の枠(アルバムからランダムで1枚。「毎月の設定」を開くたびに替える。写真が無ければ仮の絵) */
const headPhoto = createSlot($("monthly-photo"), $("monthly-photo-img"));

/** つぎに「毎月の設定」を開いたときに出す月を決めておく(「見る」の明細から来るとき) */
export function setMonthlyMonth(month) {
  state.nextMonth = month;
}

/** 「毎月の設定」のタブを開いたとき: 今月(または指定の月)を出す。下書きがあれば、続きから */
export function showMonthly() {
  state.month = state.nextMonth || todayString().slice(0, 7);
  state.nextMonth = "";
  state.taxOpen = null;
  state.user = store.getUser();
  closeDialog();
  setNotice("");
  loadDraft();
  render();
  headPhoto.shuffle();
}

/** 保存先から新しいデータが届いたとき: 出ていれば出しなおす(金額を打っている最中は、打ち終わってから) */
export function refreshMonthly() {
  if (!isShown() || state.busy) return;
  const active = document.activeElement;
  if (active && active.classList && active.classList.contains("mrow__input")) {
    state.stale = true;
    return;
  }
  render();
}

/** 裏での取得のようす(app.js から)。読み込み前の表示に使う */
export function setMonthlySyncState(value) {
  state.sync = value;
  if (isShown() && store.getMonthlyReady() !== true) render();
}

/**
 * @param {object} callbacks
 * @param {(result: object) => void} callbacks.applyServerData 保存先から返った最新の内容を、端末に保存する
 * @param {() => void} callbacks.onAuthLost 合言葉が通らなくなった
 * @param {() => void} callbacks.requestSync 最新の内容を取り直してほしい
 */
export function initMonthly(callbacks) {
  hooks = { ...hooks, ...callbacks };

  el.prev.addEventListener("click", () => moveMonth(-1));
  el.next.addEventListener("click", () => moveMonth(1));
  el.taxToggle.addEventListener("click", () => {
    state.taxOpen = !state.taxOpen;
    paintTax();
  });
  el.submit.addEventListener("click", submit);

  el.body.addEventListener("input", (event) => {
    if (event.target.classList.contains("mrow__input")) onAmountInput(event.target);
  });
  el.body.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.classList.contains("mrow__input")) {
      event.preventDefault();
      event.target.blur();
    }
  });
  el.body.addEventListener("focusout", (event) => {
    if (!state.stale || !event.target.classList.contains("mrow__input")) return;
    // 入力中に届いていた新しいデータで、出しなおす(つぎの欄へ移っただけなら、まだ待つ)
    setTimeout(() => {
      if (state.stale) refreshMonthly();
    }, 0);
  });
  el.body.addEventListener("click", (event) => {
    const add = event.target.closest("[data-add]");
    if (add) {
      openDialog("add", add.dataset.add);
      return;
    }
    const edit = event.target.closest("[data-edit]");
    if (edit) {
      const entry = state.rows.get(edit.dataset.edit);
      if (entry) openDialog("edit", "", entry.item);
    }
  });

  // 項目の追加・変更
  el.form.addEventListener("submit", saveItem);
  el.cancel.addEventListener("click", closeDialog);
  el.stop.addEventListener("click", stopItem);
  el.groups.addEventListener("click", (event) => {
    const button = event.target.closest("[data-group]");
    if (!button || !state.dialog || state.dialog.busy) return;
    state.dialog.group = GROUPS.find((g) => g.key === button.dataset.group) || state.dialog.group;
    paintDialog();
  });
  for (const button of el.varies) {
    button.addEventListener("click", () => {
      if (!state.dialog || state.dialog.busy) return;
      state.dialog.varies = button.dataset.varies === "true";
      paintDialog();
    });
  }
  el.name.addEventListener("input", () => {
    el.name.removeAttribute("data-invalid");
    if (el.name.value.length > MAX_NAME_LENGTH) el.name.value = el.name.value.slice(0, MAX_NAME_LENGTH);
  });
  el.name.addEventListener("keydown", (event) => {
    // キーボードの「完了」では送信しない(ボタンで押す)。変換中の Enter は無視
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      el.name.blur();
    }
  });
  el.amount.addEventListener("input", () => setItemAmount(el.amount.value));
  el.amount.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      el.amount.blur();
    }
  });
  el.amountBox.addEventListener("click", () => el.amount.focus());
  el.dialog.addEventListener("click", (event) => {
    if (event.target === el.dialog && state.dialog && !state.dialog.busy) closeDialog(); // 外側を押したら閉じる
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.dialog && !state.dialog.busy) closeDialog();
  });
}
