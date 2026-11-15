// 入力画面(仕様書 4.1)。
//
// 速さの約束(仕様書 5章)
//   「きろくする」を押したら、その場で入力欄を空にして一言を変える。
//   記録は端末のキュー(queue.js)に積むだけで、保存先への送信は裏で行う。待たせない。

import { DEFAULT_CATEGORIES, MEMO_SUGGESTION_COUNT, WALLET_JOINT } from "./config.js";
import { createSlot } from "./photos.js";
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
/** アプリを離れてこの時間がたってから戻ったら、「開いた」と見なして、上の写真を別の1枚に替える */
const PHOTO_SHUFFLE_MS = 30 * 1000;
/** 見えている高さ(visualViewport)が、画面の高さよりこれ以上低いとき、「キーボードが出ている」と見なす */
const KEYBOARD_MIN_PX = 60;
/** 入力欄にフォーカスしてから、位置を合わせ直すタイミング(ミリ秒)。
    iPhone のキーボードは少しかけて出てくるうえ、出きった合図(visualViewport の resize)が来ないこともあるので、念のため */
const REVEAL_RETRY_MS = [60, 300, 600, 1000];
/** 記録の直後に上へ戻すとき、この時間のあいだは、キーボードが閉じて画面の高さが変わっても、上へ戻しなおす */
const TOP_KEEP_MS = 1500;
/** 上へ戻しはじめてから、この時間がたっても戻りきっていなければ、その場で上へ(なめらかな動きは、ふつうこれより早く終わる) */
const TOP_SETTLE_MS = 700;

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
  screen: document.getElementById("screen"), // 画面の中身をスクロールさせている入れ物(window は動かない)
  view: document.getElementById("view-input"),
  footer: document.querySelector("#entry .entry__footer"),
  photo: document.getElementById("photo"),
  photoImg: document.getElementById("photo-img"),
  albumOpen: document.getElementById("album-open"),
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

/** 上の写真の枠: アルバムの写真から、開くたびにランダムで1枚(写真が1枚もないあいだは、仮の絵のまま) */
const photoSlot = createSlot(el.photo, el.photoImg);

/** app.js から受け取る合図(アルバムを開く) */
let hooks = { openAlbum() {} };

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

// --- 画面の位置(入力中の欄を見えるところへ・記録したら上へ) -------------------
//
// スクロールするのは window ではなく、.screen(#screen)。
// iPhone では、キーボードが出ても画面の高さ(window.innerHeight・100dvh)は変わらず、
// 見えている範囲(visualViewport)だけが低くなる。そのままだと、下に固定した「きろくする」と金額欄が、
// キーボードの裏に回ってしまう。そこで、キーボードが出ているあいだだけ、
//   1. 全体の枠(.app)を、見えている範囲の高さに合わせる(html に data-kb を付ける。下のタブは、そのあいだ隠す)
//      → 「きろくする」が、キーボードのすぐ上に来る
//   2. .screen をスクロールして、入力中の欄を、「きろくする」より上の見える範囲に入れる

const pos = {
  keyboard: false, // キーボードが出ている(と見なして、枠を合わせている)
  timers: [],      // 位置を合わせ直すタイマー
  frame: 0,
  target: -1,      // さいごに向かわせたスクロール位置(同じ場所へ、何度もスクロールを掛けなおさないように)
  targetAt: 0,
  seenTop: -1,     // そのとき見たスクロール位置(動いている途中かどうかを見る)
  topUntil: 0,     // この時刻までは、上へ戻している途中
  topTimer: 0,
  safeTop: null,   // 画面の上の、時計の行の高さ(中身がスクロールすると、その下にもぐる)
};

function scrollBehavior() {
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return reduce ? "auto" : "smooth";
}

/** 画面の上の、時計の行の高さ(px)。CSS の safe-area を、見えない部品で測る */
function safeTop() {
  if (pos.safeTop === null) {
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-top,0px);visibility:hidden;pointer-events:none";
    document.body.append(probe);
    pos.safeTop = probe.offsetHeight || 0;
    probe.remove();
  }
  return pos.safeTop;
}

/** いま文字を打っている欄(金額・特別費の内容)。なければ null */
function editingField() {
  const active = document.activeElement;
  return active === el.amount || active === el.memo ? active : null;
}

/** キーボードが出ているあいだ、全体の枠(.app)を、見えている範囲に合わせる。引っこんだら、元に戻す */
function fitToKeyboard() {
  const vv = window.visualViewport;
  const root = document.documentElement;
  // 入力画面だけ。指で拡大しているとき(scale が 1 でない)は、キーボードと区別できないので何もしない
  const on =
    Boolean(vv) && !el.view.hidden && Math.abs(vv.scale - 1) < 0.01 && window.innerHeight - vv.height > KEYBOARD_MIN_PX;
  if (on) {
    // iPhone は、キーボードを出すときにページごと上へずらすことがある。枠を合わせるので、ずれは戻す
    if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
    root.style.setProperty("--kb-h", `${vv.height}px`);
    // 戻しきれなかったずれ(見えている範囲の上端)には、枠のほうを合わせる
    root.style.setProperty("--kb-top", `${Math.max(0, vv.offsetTop)}px`);
    root.setAttribute("data-kb", "");
  } else if (pos.keyboard) {
    root.removeAttribute("data-kb");
    root.style.removeProperty("--kb-h");
    root.style.removeProperty("--kb-top");
    // キーボードが引っこんだあと、ページが上にずれたまま残ることがある(iPhone のホーム画面のアプリ)
    if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
  }
  pos.keyboard = on;
}

function scrollScreenTo(top) {
  const max = Math.max(0, el.screen.scrollHeight - el.screen.clientHeight);
  const to = Math.min(Math.max(0, Math.round(top)), max);
  if (Math.abs(to - el.screen.scrollTop) < 1) return;
  // 同じ場所へ向かっている途中(前に見たときから動いている)なら、掛けなおさない(なめらかな動きが、やり直しにならないように)。
  // 止まっていたら(ブラウザ自身のスクロールなどで、動きが打ち切られた)、掛けなおす
  const now = Date.now();
  const current = el.screen.scrollTop;
  const moving = current !== pos.seenTop;
  pos.seenTop = current;
  if (to === pos.target && now - pos.targetAt < 600 && moving) return;
  pos.target = to;
  pos.targetAt = now;
  el.screen.scrollTo({ top: to, behavior: scrollBehavior() });
}

/**
 * 入力中の欄(金額・特別費の内容)を、見える範囲に入れる。
 * 見える範囲 = 上は時計の行の下、下は「きろくする」の上(キーボードが出ていれば、キーボードの上)。
 * 金額のときは、入れば、選んだカテゴリの行(特別費なら内容の欄)から金額欄までを見せる。
 * 入りきらなければ、「金額」の見出しから。それも入らなければ、金額欄だけ。
 * もう見えているときは動かさない(カテゴリを選び直しただけで、画面が動かないように)
 */
function reveal() {
  const field = editingField();
  if (!field || el.view.hidden) return;
  const vv = window.visualViewport;
  if (!vv) {
    // 見えている範囲がわからない古い環境: まん中に持ってくるだけ
    (field === el.amount ? el.amountBox : field).scrollIntoView({ block: "center" });
    return;
  }
  const screenRect = el.screen.getBoundingClientRect();
  const visibleTop = Math.max(screenRect.top, vv.offsetTop) + safeTop() + 6;
  const visibleBottom = Math.min(screenRect.bottom, el.footer.getBoundingClientRect().top, vv.offsetTop + vv.height) - 8;
  const room = visibleBottom - visibleTop;

  const box = field === el.amount ? el.amountBox : el.memo;
  const bottom = box.getBoundingClientRect().bottom;
  // 見せたい範囲の上端の候補(広い順)
  const tops = [];
  if (field === el.amount) {
    if (state.kind === KIND.VARIABLE) {
      const chosen = el.categories.querySelector('[aria-pressed="true"]');
      if (chosen) tops.push(chosen.getBoundingClientRect().top);
    } else if (state.kind === KIND.SPECIAL) {
      tops.push(el.fieldMemo.getBoundingClientRect().top);
    }
    tops.push(el.fieldAmount.getBoundingClientRect().top);
  } else {
    tops.push(el.fieldMemo.getBoundingClientRect().top);
  }
  tops.push(box.getBoundingClientRect().top);
  const top = tops.find((y) => bottom - y <= room) ?? tops[tops.length - 1];

  let delta = 0;
  if (bottom > visibleBottom) {
    delta = bottom - visibleBottom; // 下にかくれている → 上へ送る
  } else if (top < visibleTop) {
    delta = top - visibleTop;       // 上にかくれている → 下へ送る
  }
  if (Math.abs(delta) < 1) return;
  scrollScreenTo(el.screen.scrollTop + delta);
}

/** 画面の高さ・見えている範囲が変わった(キーボードが出た・引っこんだ・向きを変えた) */
function onViewportChange() {
  if (pos.frame) return;
  pos.frame = requestAnimationFrame(() => {
    pos.frame = 0;
    fitToKeyboard();
    if (editingField()) {
      reveal();
    } else if (Date.now() < pos.topUntil) {
      // 記録の直後: キーボードが閉じて高さが変わっても、上へ戻りきるように
      scrollScreenTo(0);
    }
  });
}

/** 入力欄にフォーカスしたとき: すぐ位置を合わせ、キーボードが出きるまで、何度か合わせ直す */
function startReveal() {
  cancelTop();
  stopReveal();
  fitToKeyboard();
  reveal();
  pos.timers = REVEAL_RETRY_MS.map((ms) =>
    setTimeout(() => {
      fitToKeyboard();
      reveal();
    }, ms)
  );
}

function stopReveal() {
  for (const id of pos.timers) clearTimeout(id);
  pos.timers = [];
}

/**
 * キーボードを閉じて、画面をいちばん上へ戻す(吹き出しの一言が見えるように)。
 * 待たせない: 動きはじめるだけで、終わるのは待たない
 */
function scrollToTop() {
  el.amount.blur();
  el.memo.blur();
  stopReveal();
  pos.topUntil = Date.now() + TOP_KEEP_MS;
  scrollScreenTo(0);
  // なめらかなスクロールが途中で止められたとき(キーボードが閉じる動きと重なったとき)のために、さいごに確かめる
  const settle = (last) => {
    if (pos.topUntil && !editingField() && el.screen.scrollTop > 0) el.screen.scrollTop = 0;
    if (last) {
      pos.topUntil = 0;
    } else {
      pos.topTimer = setTimeout(settle, TOP_KEEP_MS - TOP_SETTLE_MS, true);
    }
  };
  clearTimeout(pos.topTimer);
  pos.topTimer = setTimeout(settle, TOP_SETTLE_MS, false);
}

/** 上へ戻すのをやめる(次の入力を始めた・自分でスクロールした) */
function cancelTop() {
  pos.topUntil = 0;
  clearTimeout(pos.topTimer);
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
    // もう金額欄にいたとき(フォーカスの合図が出ない)も、位置を確かめる。見えていれば動かない
    reveal();
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

/**
 * 入力チェックで引っかかったとき。
 *   打つ欄(金額・特別費の内容)が空のとき … その欄(赤いふち)にフォーカスして、見える位置へ。そのまま打てる
 *   カテゴリを選んでいないとき             … キーボードを閉じて上へ戻し、一言とカテゴリを見せる
 */
function invalid(node, message, focusTarget) {
  node.setAttribute("data-invalid", "true");
  say(message, "warn");
  if (focusTarget) {
    focusTarget.focus();
    // もうその欄にいたとき(フォーカスの合図が出ない)も、位置を合わせる
    startReveal();
  } else {
    scrollToTop();
  }
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
    scrollToTop();
    return;
  }

  // すぐに空にする。財布・種類・日付はそのまま(つづけて入れやすいように)
  state.category = "";
  el.memo.value = "";
  el.amount.value = "";
  setPressed(Array.from(el.categories.children), () => false);
  renderSuggestions();
  // 吹き出しを「きろくしたにゃ。」に(寝ていた・ジト目だったごまちゃんも、ここで起きる)
  startDone(record);
  // キーボードを閉じて、いちばん上へ(吹き出しと「取り消す」が見えるように。次の入力は、カテゴリ選びから)。
  // 上へ動くのは待たない。スクロールでは、吹き出しは挨拶に戻らない(戻るのは、時間がたったとき・次の入力を始めたとき)
  scrollToTop();
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
  // 開くたびに、写真を別の1枚に(端末に保存してある写真から、すぐ出す)
  photoSlot.shuffle();
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
  const away = state.hiddenAt ? Date.now() - state.hiddenAt : 0;
  state.hiddenAt = 0;
  renderDate();
  if (!state.user) return;
  // しばらく離れてから戻った = 開き直した、と見なして、写真を替える
  if (away > PHOTO_SHUFFLE_MS) photoSlot.shuffle();
  expireDone();
  // 日付や時刻が変わっていれば、挨拶のようす(ねむる・ジト目)も変わる
  if (state.mode === "greeting") renderBubble();
}

export function onHide() {
  state.hiddenAt = Date.now();
}

/**
 * @param {object} [callbacks]
 * @param {() => void} [callbacks.openAlbum] アルバムを開く(写真の右上のカメラボタン)
 */
export function initInput(callbacks = {}) {
  hooks = { ...hooks, ...callbacks };
  el.albumOpen.hidden = false;
  el.albumOpen.addEventListener("click", () => hooks.openAlbum());
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
  // 打つ欄にフォーカスしたら(カテゴリ・候補を押したとき、欄を直接押したとき)、見える位置へ
  for (const field of [el.amount, el.memo]) {
    field.addEventListener("focus", startReveal);
    field.addEventListener("blur", stopReveal);
  }
  // キーボードが出た・引っこんだ(iPhone では、見えている範囲 visualViewport だけが変わる)
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", onViewportChange);
    window.visualViewport.addEventListener("scroll", onViewportChange);
  }
  window.addEventListener("resize", onViewportChange);
  // 自分でスクロールしはじめたら、上へ戻すのはやめる
  for (const type of ["pointerdown", "wheel"]) {
    el.screen.addEventListener(type, cancelTop, { passive: true });
  }
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
