// 入力画面(仕様書 4.1)。
//
// 速さの約束(仕様書 5章)
//   「きろくする」を押したら、その場で入力欄を空にして一言を変える。
//   記録は端末のキュー(queue.js)に積むだけで、保存先への送信は裏で行う。待たせない。

import { DEFAULT_CATEGORIES, MEMO_SUGGESTION_COUNT, WALLET_JOINT } from "./config.js";
import * as queue from "./queue.js";
import * as store from "./store.js";
import { applyQueue } from "./summary.js";
import { digitsOnly, formatAmount, formatDateShort, isDateString, newId, todayString } from "./util.js";

const KIND = Object.freeze({ VARIABLE: "変動費", SPECIAL: "特別費", DEPOSIT: "共同へ入金" });
const MAX_AMOUNT_DIGITS = 8; // 保存先の上限(99,999,999円)と同じ
/** アプリを離れてこの時間がたったら、変更していた日付を「きょう」に戻す */
const DATE_KEEP_MS = 10 * 60 * 1000;
/** 記録の直後の吹き出し(「きろくしたにゃ。」と「取り消す」)を出しておく時間。すぎたら、挨拶に戻す。
    戻ると「取り消す」は押せなくなる(そのあとは「見る」の明細から、なおす・消す)ので、気づいて押せるだけの長さにしてある */
const DONE_SHOW_MS = 10 * 1000;
/** 自分の記録がこの日数以上ないと、ごまちゃんが寝ている */
const SLEEP_DAYS = 3;
/** この時刻(端末の時計)をすぎても、今日の自分の記録がないと、ジト目になる */
const NIGHT_HOUR = 20;

/** 吹き出しの左に出す絵(表示の大きさ) */
const FIGURE = Object.freeze({
  reach: { src: "img/goma-reach.png", width: 46, height: 61 }, // 手をのばす: 記録の直後
  sleep: { src: "img/goma-sleep.png", width: 64, height: 48 }, // ねむる: しばらく記録がない
  jito: { src: "img/goma-jito.png", width: 58, height: 55 },   // ジト目: 夜になっても今日の記録がない
});

const LINE = Object.freeze({
  welcome: (user) => `おかえり、${user}。きょうは何につかったにゃ？`,
  sleep: "…むにゃ。ひさしぶりだにゃ。",
  jito: "きょうは、まだつけてないにゃ…",
  done: "きろくしたにゃ。",
  undone: "とりけしたにゃ。なおして、もういちどどうぞ。",
  needCategory: "カテゴリをえらんでにゃ。",
  needMemo: "なにに使ったか、内容を書いてにゃ。",
  needAmount: "金額を入れてにゃ。",
  storage: "この iPhone に書きこめなかったにゃ…。空き容量や、プライベートブラウズになっていないかを見てみてね。",
  dropped: "ごめんにゃ、1件だけ保存先に受けつけてもらえなかったにゃ。もういちど入れてみてね。",
});

const el = {
  photo: document.getElementById("photo"),
  pending: document.getElementById("pending"),
  pendingText: document.getElementById("pending-text"),
  paw: document.getElementById("input-paw"),
  goma: document.getElementById("input-goma"),
  line: document.getElementById("input-line"),
  lastText: document.getElementById("last-text"),
  undo: document.getElementById("undo"),
  form: document.getElementById("entry"),
  wallets: Array.from(document.querySelectorAll("#wallets .choice")),
  kinds: Array.from(document.querySelectorAll("#kinds .choice")),
  fieldCategory: document.getElementById("field-category"),
  categories: document.getElementById("categories"),
  fieldMemo: document.getElementById("field-memo"),
  memo: document.getElementById("memo"),
  fieldSuggestions: document.getElementById("field-suggestions"),
  suggestions: document.getElementById("suggestions"),
  depositNote: document.getElementById("deposit-note"),
  fieldAmount: document.getElementById("field-amount"),
  amountBox: document.getElementById("amount-box"),
  amount: document.getElementById("amount"),
  dateText: document.getElementById("date-text"),
  dateToday: document.getElementById("date-today"),
  datePicker: document.getElementById("date-picker"),
  submitText: document.getElementById("submit-text"),
};

// いまの入力内容
const state = {
  user: "",
  wallet: "self",        // "self" | "joint"(前回の選択を覚える)
  kind: KIND.VARIABLE,   // 起動のたびに変動費から
  category: "",
  date: null,            // null = きょう(記録する瞬間の日付を使う) / 'YYYY-MM-DD' = 変更した日
  last: null,            // 直前に記録した1件(取り消す用)。吹き出しが挨拶に戻ったら null
  hiddenAt: 0,
  // 吹き出しに出しているもの: "greeting" = 挨拶 / "done" = 記録の直後 / "message" = そのほかの一言(注意など)
  mode: "greeting",
  message: { text: "", tone: "" },
  doneAt: 0,             // 記録の直後の吹き出しを出した時刻
  doneTimer: 0,
};

// --- 一言(吹き出し) ---------------------------------------------------------

/** 'YYYY-MM-DD' どうしの日数の差(b - a) */
function daysBetween(a, b) {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((new Date(by, bm - 1, bd) - new Date(ay, am - 1, ad)) / 86400000);
}

/**
 * 挨拶のときの、ごまちゃんのようす。優先順に:
 *   "sleep"  … 自分の記録が3日以上ない
 *   "jito"   … 20時をすぎたのに、今日の自分の記録がない
 *   "normal" … いつもの挨拶
 * 「自分の記録」= 記録した人が自分で、アプリから入れた記録(財布は自分でも共同口座でもよい。まだ送れていない分も数える。
 *   「毎月の設定」の自動の記録や、フォームから取り込んだ記録は数えない)。
 * 日にちは、記録の「日付」ではなく、記録した日(作成日時)で数える。
 *   あとから前の日付でまとめて入れても「きょう、つけた」ことになり、先の日付で入れても「つけた日」は変わらないように。
 * 記録が1件もない使いはじめは、寝かせない。
 */
function greetingMood() {
  const user = state.user;
  const { records } = applyQueue(store.getRecords(), queue.pendingOps(), user);
  let latest = ""; // いちばん新しい「記録した日」
  for (const r of records) {
    if (!r || r["記録した人"] !== user || r["元"] !== "アプリ") continue;
    const created = String(r["作成日時"] || "").slice(0, 10);
    const day = isDateString(created) ? created : String(r["日付"] || "");
    if (isDateString(day) && day > latest) latest = day;
  }
  // まだ一度も保存先から読みこめていないあいだは、記録があるかどうかわからないので、いつもの挨拶
  if (!latest && !store.getSyncedAt()) return "normal";
  const today = todayString();
  if (latest && daysBetween(latest, today) >= SLEEP_DAYS) return "sleep";
  if (new Date().getHours() >= NIGHT_HOUR && latest !== today) return "jito";
  return "normal";
}

/** 吹き出しの左: 絵(name)を出す。null なら、肉球マークに戻す。絵は、はじめて出すときに読みこむ */
function showFigure(name) {
  const figure = name ? FIGURE[name] : null;
  el.paw.style.display = figure ? "none" : "";
  el.goma.hidden = !figure;
  if (!figure) return;
  if (el.goma.getAttribute("src") !== figure.src) {
    el.goma.dataset.figure = name;
    el.goma.width = figure.width;
    el.goma.height = figure.height;
    el.goma.src = figure.src;
  }
}

function setLine(text, tone = "") {
  // 同じ文字のときは書きかえない(読み上げが、くり返されないように)
  if (el.line.textContent !== text) el.line.textContent = text;
  if (tone) {
    el.line.dataset.tone = tone;
  } else {
    delete el.line.dataset.tone;
  }
}

/** 吹き出しを、いまの状態で出しなおす */
function renderBubble() {
  if (state.mode === "done" && state.last) {
    showFigure("reach");
    setLine(LINE.done);
  } else if (state.mode === "message") {
    showFigure(null);
    setLine(state.message.text, state.message.tone);
  } else {
    state.mode = "greeting";
    const mood = greetingMood();
    showFigure(mood === "normal" ? null : mood);
    setLine(mood === "sleep" ? LINE.sleep : mood === "jito" ? LINE.jito : LINE.welcome(state.user));
  }
  renderLast();
}

/** 注意などの一言を出す */
function say(text, tone = "") {
  state.mode = "message";
  state.message = { text, tone };
  renderBubble();
}

/** 記録の直後の吹き出しを出す。少ししたら挨拶に戻す */
function startDone(record) {
  clearTimeout(state.doneTimer);
  state.last = record;
  state.mode = "done";
  state.doneAt = Date.now();
  state.doneTimer = setTimeout(endDone, DONE_SHOW_MS);
  renderBubble();
}

/** 記録の直後の吹き出しを終えて、挨拶に戻す(時間がたった・次の入力を始めた)。「取り消す」も、ここまで */
function endDone() {
  if (state.mode !== "done") return;
  clearTimeout(state.doneTimer);
  state.last = null;
  state.mode = "greeting";
  renderBubble();
}

function clearInvalid() {
  for (const node of [el.categories, el.memo, el.amountBox]) {
    node.removeAttribute("data-invalid");
  }
}

// --- 表示 -------------------------------------------------------------------

function setPressed(buttons, isOn) {
  for (const button of buttons) {
    button.setAttribute("aria-pressed", isOn(button) ? "true" : "false");
  }
}

function renderWallet() {
  const deposit = state.kind === KIND.DEPOSIT;
  // 「共同へ入金」は、いつも自分の財布から。財布の選択は無視する(覚えている選択は変えない)
  setPressed(el.wallets, (b) => b.dataset.wallet === (deposit ? "self" : state.wallet));
  for (const button of el.wallets) {
    button.disabled = deposit && button.dataset.wallet !== "self";
  }
}

function renderKind() {
  setPressed(el.kinds, (b) => b.dataset.kind === state.kind);
  el.fieldCategory.hidden = state.kind !== KIND.VARIABLE;
  el.fieldMemo.hidden = state.kind !== KIND.SPECIAL;
  el.depositNote.hidden = state.kind !== KIND.DEPOSIT;
  renderPeek();
  renderSuggestions();
  renderWallet();
}

/**
 * 金額欄の、のぞきごま。変動費のときだけ出す(特別費・共同へ入金は、縦の余白が足りない)。
 * カテゴリのいちばん下の段の右はし(3列目)が空いていれば、そこに顔が入るので "tight"(上を空けない)。
 * うまっていれば "room"(ボタンに重ならないように、上を空ける)
 */
function renderPeek() {
  if (state.kind !== KIND.VARIABLE) {
    el.fieldAmount.removeAttribute("data-peek");
    return;
  }
  el.fieldAmount.setAttribute("data-peek", el.categories.children.length % 3 === 0 ? "room" : "tight");
}

function categoryList() {
  const list = store.getCategories();
  return list.length ? list : DEFAULT_CATEGORIES;
}

function renderCategories() {
  const list = categoryList();
  if (!list.includes(state.category)) {
    state.category = "";
  }
  el.categories.textContent = "";
  for (const name of list) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "choice choice--category";
    button.dataset.category = name;
    button.setAttribute("aria-pressed", name === state.category ? "true" : "false");
    // 肉球マーク(選択中だけ CSS で見せる)
    button.insertAdjacentHTML(
      "afterbegin",
      '<svg class="choice__paw" aria-hidden="true" width="15" height="15" fill="currentColor"><use href="#i-paw"></use></svg>'
    );
    const label = document.createElement("span");
    label.textContent = name;
    button.append(label);
    el.categories.append(button);
  }
  renderPeek();
}

/** 特別費の候補: 自分の財布と共同口座の、過去のメモ。新しい順・重複なしで数個 */
function memoSuggestions() {
  const wallets = [state.user, WALLET_JOINT];
  const saved = store
    .getRecords()
    .filter((r) => r && r["種類"] === KIND.SPECIAL && wallets.includes(r["財布"]))
    .sort((a, b) => {
      const ka = `${a["日付"] || ""} ${a["作成日時"] || ""}`;
      const kb = `${b["日付"] || ""} ${b["作成日時"] || ""}`;
      return ka < kb ? 1 : ka > kb ? -1 : 0;
    });
  // まだ送れていない分は、いちばん新しいものとして先頭に
  const unsent = queue.pendingRecords().filter((r) => r["種類"] === KIND.SPECIAL);
  const result = [];
  for (const record of [...unsent, ...saved]) {
    const memo = String(record["メモ"] || "").trim();
    if (memo && !result.includes(memo)) {
      result.push(memo);
      if (result.length >= MEMO_SUGGESTION_COUNT) break;
    }
  }
  return result;
}

function renderSuggestions() {
  const list = state.kind === KIND.SPECIAL ? memoSuggestions() : [];
  el.fieldSuggestions.hidden = list.length === 0;
  el.suggestions.textContent = "";
  for (const memo of list) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    button.dataset.memo = memo;
    button.textContent = memo;
    el.suggestions.append(button);
  }
}

function currentDate() {
  return state.date || todayString();
}

function renderDate() {
  const today = todayString();
  if (state.date === today) {
    state.date = null;
  }
  const changed = state.date !== null;
  el.dateText.textContent = changed ? formatDateShort(state.date) : `きょう ${formatDateShort(today)}`;
  el.dateText.toggleAttribute("data-changed", changed);
  el.dateToday.hidden = !changed;
  // 日付の行が画面の下に隠れていても気づけるように、ボタンにも出す
  el.submitText.textContent = changed ? `${formatDateShort(state.date)}の分をきろくする` : "きろくする";
  el.datePicker.value = currentDate();
}

function renderPending() {
  const count = queue.pendingCount();
  el.pending.hidden = count === 0;
  el.pendingText.textContent = `未送信 ${count}件`;
}

/** 直前に記録した内容(例: 食費 ¥1,280)と「取り消す」。記録の直後だけ出す */
function renderLast() {
  const r = state.last;
  el.undo.hidden = !r;
  el.lastText.hidden = !(r && state.mode === "done");
  if (!r) return;
  const label = r["種類"] === KIND.VARIABLE ? r["項目"] : r["種類"] === KIND.SPECIAL ? r["メモ"] : KIND.DEPOSIT;
  const parts = [`${label} ¥${formatAmount(r["金額"])}`];
  // きょう以外の日付で入れたとき・共同口座に入れたときは、まちがいに気づけるように添える
  if (r["日付"] !== todayString()) parts.push(formatDateShort(r["日付"]));
  if (r["財布"] === WALLET_JOINT) parts.push(WALLET_JOINT);
  el.lastText.textContent = parts.join("・");
}

// --- 操作 -------------------------------------------------------------------

function selectWallet(wallet) {
  if (state.kind === KIND.DEPOSIT) return;
  endDone();
  state.wallet = wallet;
  store.setWallet(wallet);
  renderWallet();
}

function selectKind(kind) {
  endDone();
  state.kind = kind;
  clearInvalid();
  renderKind();
}

function selectCategory(name) {
  endDone();
  state.category = name;
  el.categories.removeAttribute("data-invalid");
  setPressed(Array.from(el.categories.children), (b) => b.dataset.category === name);
  // つづけて金額を打てるように(カテゴリ → 金額 → きろくする の3操作)
  if (!el.amount.value) {
    el.amount.focus({ preventScroll: false });
  }
}

function setAmountText(text) {
  const digits = digitsOnly(text).slice(0, MAX_AMOUNT_DIGITS);
  el.amount.value = digits ? formatAmount(Number(digits)) : "";
}

function amountValue() {
  const digits = digitsOnly(el.amount.value);
  return digits ? Number(digits) : 0;
}

function invalid(node, message, focusTarget) {
  node.setAttribute("data-invalid", "true");
  say(message, "warn");
  if (focusTarget) focusTarget.focus();
}

/** 「きろくする」: その場で確かめて、キューに積み、入力欄を空にする(通信は待たない) */
function submit(event) {
  event.preventDefault();
  endDone();
  clearInvalid();

  const kind = state.kind;
  const memo = el.memo.value.trim();
  if (kind === KIND.VARIABLE && !state.category) {
    invalid(el.categories, LINE.needCategory);
    return;
  }
  if (kind === KIND.SPECIAL && !memo) {
    invalid(el.memo, LINE.needMemo, el.memo);
    return;
  }
  const amount = amountValue();
  if (!(amount > 0)) {
    invalid(el.amountBox, LINE.needAmount, el.amount);
    return;
  }

  const record = {
    id: newId(),
    日付: currentDate(),
    財布: kind === KIND.DEPOSIT || state.wallet === "self" ? state.user : WALLET_JOINT,
    種類: kind,
    項目: kind === KIND.VARIABLE ? state.category : "",
    メモ: kind === KIND.SPECIAL ? memo : "",
    金額: amount,
  };

  if (!queue.enqueueAdd(record)) {
    // 端末に書けなかったときは、入力を消さずに知らせる(消すと、記録したつもりになってしまう)
    say(LINE.storage, "warn");
    return;
  }

  // すぐに空にする。財布・種類・日付はそのまま(つづけて入れやすいように)
  state.category = "";
  el.memo.value = "";
  el.amount.value = "";
  el.amount.blur();
  el.memo.blur();
  setPressed(Array.from(el.categories.children), () => false);
  renderSuggestions();
  // 吹き出しを「きろくしたにゃ。」に(寝ていた・ジト目だったごまちゃんも、ここで起きる)
  startDone(record);
}

/** 「取り消す」: 直前の1件を取り消して、内容を入力欄に戻す(直して入れ直せるように) */
function undo() {
  const record = state.last;
  if (!record) return;
  clearTimeout(state.doneTimer);
  if (queue.cancel(record.id) === "failed") {
    // 取り消せなかったときは、「取り消す」を残しておく(もういちど押せるように)
    say(LINE.storage, "warn");
    return;
  }
  state.last = null;
  state.kind = record["種類"];
  if (record["種類"] !== KIND.DEPOSIT) {
    state.wallet = record["財布"] === WALLET_JOINT ? "joint" : "self";
    store.setWallet(state.wallet);
  }
  state.category = record["項目"];
  state.date = record["日付"];
  el.memo.value = record["メモ"];
  setAmountText(String(record["金額"]));
  clearInvalid();
  renderCategories();
  renderKind();
  renderDate();
  say(LINE.undone);
}

function pickDate() {
  endDone();
  const value = el.datePicker.value;
  // iPhone の「リセット」で空になったら、きょうに戻す
  state.date = value && isDateString(value) ? value : null;
  renderDate();
}

function openPicker() {
  // パソコンのブラウザ用(iPhone では、透明な日付入力を直接押すので、これが無くても開く)
  try {
    if (typeof el.datePicker.showPicker === "function") el.datePicker.showPicker();
  } catch {
    /* 開けなくても、入力欄にフォーカスは当たる */
  }
}

// --- 外から呼ぶもの ---------------------------------------------------------

/** 入力画面を、いまの持ち主の内容で出しなおす */
export function showInput() {
  const user = store.getUser();
  if (state.user !== user) {
    // 持ち主が変わった(登録し直した)ら、入力途中の内容は捨てる
    state.user = user;
    clearTimeout(state.doneTimer);
    state.last = null;
    state.mode = "greeting";
    state.kind = KIND.VARIABLE;
    state.category = "";
    state.date = null;
    el.memo.value = "";
    el.amount.value = "";
  }
  expireDone();
  state.wallet = store.getWallet();
  el.wallets[0].textContent = user || "自分";
  el.depositNote.textContent = `${user}の財布から共同口座への入金として記録します。ふたりの画面に表示されます。`;
  clearInvalid();
  renderCategories();
  renderKind();
  renderDate();
  renderBubble();
  renderPending();
}

/** 記録の直後の吹き出しの時間がすぎていたら、挨拶に戻す(裏にいるあいだはタイマーが止まることがあるので、戻ってきたときにも確かめる) */
function expireDone() {
  if (state.mode === "done" && Date.now() - state.doneAt >= DONE_SHOW_MS) endDone();
}

/** 保存先から新しいデータが届いたとき: カテゴリと候補を出しなおす(入力途中の内容は変えない) */
export function refreshData() {
  if (!state.user) return;
  renderCategories();
  renderSuggestions();
  // 挨拶のようす(ねむる・ジト目)は、届いた記録で変わることがある
  if (state.mode === "greeting") renderBubble();
}

/** 画面に戻ってきたとき: 日付の表示を直す。長く離れていたら、変更していた日付を「きょう」に戻す */
export function onResume() {
  if (state.date && state.hiddenAt && Date.now() - state.hiddenAt > DATE_KEEP_MS) {
    state.date = null;
  }
  state.hiddenAt = 0;
  renderDate();
  if (!state.user) return;
  expireDone();
  // 日付や時刻が変わっていれば、挨拶のようす(ねむる・ジト目)も変わる
  if (state.mode === "greeting") renderBubble();
}

export function onHide() {
  state.hiddenAt = Date.now();
}

export function initInput() {
  for (const button of el.wallets) {
    button.addEventListener("click", () => selectWallet(button.dataset.wallet));
  }
  for (const button of el.kinds) {
    button.addEventListener("click", () => selectKind(button.dataset.kind));
  }
  el.categories.addEventListener("click", (event) => {
    const button = event.target.closest("[data-category]");
    if (button) selectCategory(button.dataset.category);
  });
  el.suggestions.addEventListener("click", (event) => {
    const button = event.target.closest("[data-memo]");
    if (!button) return;
    endDone();
    el.memo.value = button.dataset.memo;
    el.memo.removeAttribute("data-invalid");
    if (!el.amount.value) el.amount.focus();
  });
  el.memo.addEventListener("input", () => {
    endDone();
    el.memo.removeAttribute("data-invalid");
  });
  el.memo.addEventListener("keydown", (event) => {
    // キーボードの「次へ」で金額へ(変換中の Enter は無視)
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      el.amount.focus();
    }
  });
  el.amount.addEventListener("input", () => {
    endDone();
    setAmountText(el.amount.value);
    el.amountBox.removeAttribute("data-invalid");
  });
  el.amountBox.addEventListener("click", () => el.amount.focus());
  el.datePicker.addEventListener("change", pickDate);
  el.datePicker.addEventListener("click", openPicker);
  el.dateToday.addEventListener("click", () => {
    endDone();
    state.date = null;
    renderDate();
  });
  el.form.addEventListener("submit", submit);
  el.undo.addEventListener("click", undo);
  el.pending.addEventListener("click", () => queue.flush());

  queue.subscribe((event) => {
    if (event.type === "change") {
      renderPending();
    } else if (event.type === "dropped" && event.op.op === "add") {
      if (state.last && state.last.id === event.op.record.id) {
        clearTimeout(state.doneTimer);
        state.last = null;
      }
      say(LINE.dropped, "warn");
    }
  });

  // 「きろくする」を押してすぐ絵が出るように、手があいたときに先に読みこんでおく(登録済みのときだけ)
  window.addEventListener("load", () => {
    setTimeout(() => {
      if (store.getUser()) new Image().src = FIGURE.reach.src;
    }, 1500);
  });
}
