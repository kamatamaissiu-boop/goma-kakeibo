// 「見る」画面(仕様書 4.2)と、明細の修正・削除(仕様書 5章)。
//
//   - 端末に保存してある前回のデータ(store)で、すぐ表示する。最新は app.js が裏で取りに行く。
//   - まだ送れていない追加・修正・削除(queue)も重ねて集計する。押した直後でも数字が合う。
//   - 修正・削除も、入力と同じく「端末のキューに積んで、裏で送る」。待たせない。
//   - 相手の財布は出さない(共同口座の入金の内訳にある、相手の入金額だけは見える)。
//   - 「毎月の設定」で確定した固定費・貯蓄も明細に出すが、ここからは直せない(押すと「毎月の設定」へ)。
//   集計の決まりは summary.js の先頭に書いてある。
//
// まだ無いもの(足す場所は index.html にコメントで示してある)
//   段階4: 「今週の肉球スタンプ」、共同口座カードの写真

import { DEFAULT_CATEGORIES, WALLET_JOINT } from "./config.js";
import * as queue from "./queue.js";
import * as store from "./store.js";
import {
  KIND,
  MONTHLY,
  addMonth,
  applyQueue,
  canEdit,
  estimateNextDeposit,
  filterDetails,
  isAuto,
  monthRange,
  recordMonth,
  summarize,
} from "./summary.js";
import { digitsOnly, formatAmount, formatDateShort, isDateString, todayString } from "./util.js";

/** 明細を、はじめに何件まで出すか(それ以上は「もっと見る」) */
const DETAILS_FIRST = 8;
const MAX_AMOUNT_DIGITS = 8; // 保存先の上限(99,999,999円)と同じ

const LINE = Object.freeze({
  good: "いいペースだにゃ",
  warn: "そろそろ気をつけるにゃ",
  over: "入金より多くつかってるにゃ",
  nodeposit: "まだ入金がないにゃ",
  empty: "まだ動きがないにゃ",
  updated: "なおしたにゃ。",
  deleted: "消したにゃ。",
  storage: "この iPhone に書きこめなかったにゃ…。空き容量や、プライベートブラウズになっていないかを見てみてね。",
  dropped: "ごめんにゃ、1件だけ保存先に受けつけてもらえなかったにゃ。最新の内容に戻したにゃ。",
  needUpdate: "保存先の更新が必要にゃ。それまで、このなおしは「送信待ち」のまま取っておくにゃ（ほかの記録は、ふつうに送れます）。",
  noMonth: "この月のきろくは、まだないにゃ。",
  loading: "さいしんのきろくを、よみこみ中にゃ…",
  loadFailed: "まだ読みこめていないにゃ。電波のよいところで、もういちど開いてみてね。",
  needDate: "日付をえらんでにゃ。",
  needCategory: "カテゴリをえらんでにゃ。",
  needMemo: "なにに使ったか、内容を書いてにゃ。",
  needAmount: "金額を入れてにゃ。",
});

const $ = (id) => document.getElementById(id);

const el = {
  screen: $("screen"),
  view: $("view-view"),
  main: $("look-main"),
  prev: $("month-prev"),
  next: $("month-next"),
  title: $("month-title"),
  notice: $("look-notice"),
  empty: $("look-empty"),
  emptyText: $("look-empty-text"),
  cards: $("look-cards"),
  // 共同口座
  remain: $("joint-remain"),
  jointLine: $("joint-line"),
  gauge: $("gauge"),
  deposit: $("joint-deposit"),
  depositBy: $("joint-deposit-by"),
  spend: $("joint-spend"),
  spendRate: $("joint-spend-rate"),
  spendFixed: $("joint-spend-fixed"),
  // 自分の財布
  walletTitle: $("wallet-title"),
  walletTotal: $("wallet-total"),
  walletNone: $("wallet-none"),
  bars: $("wallet-bars"),
  specials: $("wallet-specials"),
  extras: $("wallet-extras"),
  // 来月の目安
  estimate: $("estimate"),
  estimateTitle: $("estimate-title"),
  estimateNums: $("estimate-nums"),
  estimateFormula: $("estimate-formula"),
  estimateList: $("estimate-list"),
  walletDeposit: $("wallet-deposit"),
  walletDepositAmount: $("wallet-deposit-amount"),
  walletMore: $("wallet-more"),
  // 明細
  details: $("details"),
  filters: Array.from(document.querySelectorAll("#details-filters .filter")),
  filterSelf: $("filter-self"),
  detailsNone: $("details-none"),
  list: $("details-list"),
  more: $("details-more"),
  // 修正
  edit: $("edit"),
  editBack: $("edit-back"),
  editMeta: $("edit-meta"),
  editDate: $("edit-date"),
  editWallets: Array.from(document.querySelectorAll("#edit-wallets .choice")),
  editKinds: Array.from(document.querySelectorAll("#edit-kinds .choice")),
  editFieldCategory: $("edit-field-category"),
  editCategories: $("edit-categories"),
  editFieldMemo: $("edit-field-memo"),
  editMemo: $("edit-memo"),
  editDepositNote: $("edit-deposit-note"),
  editAmountBox: $("edit-amount-box"),
  editAmount: $("edit-amount"),
  editError: $("edit-error"),
  editDelete: $("edit-delete"),
  // 確認のダイアログ
  confirm: $("confirm"),
  confirmWhat: $("confirm-what"),
  confirmNo: $("confirm-no"),
  confirmYes: $("confirm-yes"),
};

const state = {
  user: "",
  month: "",          // 見ている月 'YYYY-MM'
  filter: "all",      // 明細のしぼりこみ: "all" | "self" | "joint"
  expanded: false,    // 明細を全部出しているか
  sync: "idle",       // 裏での取得: "idle" | "loading" | "ok" | "error"
  records: [],        // いま画面に出している記録(未送信の分を重ねたもの)
  editing: null,      // 修正中の記録(元の内容)
  form: null,         // 修正中の入力内容 { wallet: "self"|"joint", kind, category }
  scrollTop: 0,       // 修正を開く前のスクロール位置
};

/** app.js から受け取る合図(「毎月の設定」を、その月で開く) */
let hooks = { openMonthly() {} };

// --- 小さな道具 -------------------------------------------------------------

function yen(amount) {
  return amount < 0 ? `-¥${formatAmount(-amount)}` : `¥${formatAmount(amount)}`;
}

/** 入金の内訳用の短い書き方: 60000 → '6万' / 65000 → '6.5万' / 61500 → '¥61,500' */
function shortAmount(amount) {
  if (amount === 0) return "0円";
  if (amount >= 10000 && amount % 1000 === 0) return `${amount / 10000}万`;
  return yen(amount);
}

function monthTitle(month) {
  const [y, m] = month.split("-").map(Number);
  return `${y}年${m}月`;
}

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

function pawIcon(size) {
  const span = node("span", "paw-mark");
  span.innerHTML = `<svg aria-hidden="true" width="${size}" height="${size}" fill="currentColor"><use href="#i-paw"></use></svg>`;
  return span;
}

function isShown() {
  return !el.view.hidden;
}

function setNotice(text, tone = "") {
  el.notice.hidden = !text;
  el.notice.textContent = text || "";
  if (tone) {
    el.notice.dataset.tone = tone;
  } else {
    delete el.notice.dataset.tone;
  }
}

/** 記録の、明細での呼び名(変動費 = カテゴリ / 特別費 = 書いた内容 / 共同へ入金) */
function labelOf(record) {
  if (record["種類"] === KIND.VARIABLE) return record["項目"] || "(カテゴリなし)";
  if (record["種類"] === KIND.SPECIAL) return record["メモ"] || "(内容なし)";
  if (record["種類"] === KIND.DEPOSIT) return KIND.DEPOSIT;
  return record["項目"] || record["メモ"] || record["種類"] || "";
}

function describe(record) {
  const date = isDateString(record["日付"]) ? formatDateShort(record["日付"]) : String(record["日付"] || "");
  return `${date}・${labelOf(record)}・${yen(Number(record["金額"]) || 0)}`;
}

// --- 表示 -------------------------------------------------------------------

function renderJoint(joint) {
  el.remain.textContent = yen(joint.remain);
  el.remain.toggleAttribute("data-minus", joint.remain < 0);
  el.jointLine.textContent = LINE[joint.state];

  el.gauge.style.setProperty("--p", String(joint.gauge));
  el.gauge.dataset.state = joint.state;
  el.gauge.setAttribute(
    "aria-label",
    joint.ratio === null ? "入金はまだありません" : `入金のうち ${Math.round(joint.ratio * 100)}% をつかいました`
  );

  el.deposit.textContent = yen(joint.deposit);
  el.depositBy.textContent =
    joint.deposit > 0 ? joint.depositBy.map((d) => `${d.name}${shortAmount(d.amount)}`).join("・") : "まだ入金なし";
  el.spend.textContent = yen(joint.spend);
  el.spendRate.textContent =
    joint.ratio !== null ? `予定の${Math.round(joint.ratio * 100)}%` : joint.spend > 0 ? "入金がまだ" : "";
  // 支出に入っている固定費(「毎月の設定」で確定した分)
  el.spendFixed.hidden = joint.fixed === 0;
  el.spendFixed.textContent = `うち固定費 ${yen(joint.fixed)}`;
}

/** 自分の財布のカードの下のほうの1行(固定費・貯蓄・収入) */
function extraRow(tag, text, note, amount) {
  const row = node("div", "extra");
  const left = node("span", "extra__left");
  if (tag) left.append(node("span", "tag", tag));
  left.append(document.createTextNode(text));
  if (note) left.append(node("span", "extra__note", note));
  row.append(left, node("span", "extra__amount", yen(amount)));
  return row;
}

/** 項目のなまえを、短くまとめる: 'A・B・C' / 4つ以上は 'A・B ほか2件' */
function joinNames(items) {
  const names = items.map((item) => item.name).filter(Boolean);
  if (names.length <= 3) return names.join("・");
  return `${names.slice(0, 2).join("・")} ほか${names.length - 2}件`;
}

function renderWallet(wallet) {
  el.walletTitle.textContent = `${state.user}の財布`;
  el.walletTotal.textContent = yen(wallet.total);
  el.walletMore.textContent = `${state.user}の財布の明細を見る`;
  el.walletNone.hidden = wallet.categories.length > 0 || wallet.specials.length > 0 || wallet.fixed.total > 0;

  // カテゴリ別の横棒(変動費だけ)。いちばん多いカテゴリを 100% にする
  el.bars.textContent = "";
  for (const item of wallet.categories) {
    const row = node("div", "bar");
    const head = node("div", "bar__head");
    const name = node("span", "bar__name");
    if (item.name === "ごまちゃん") name.append(pawIcon(15));
    name.append(document.createTextNode(item.name));
    head.append(name, node("span", "bar__amount", yen(item.amount)));
    const track = node("div", "bar__track");
    const fill = node("div", "bar__fill");
    fill.style.width = `${wallet.max > 0 ? Math.max(2, Math.round((item.amount / wallet.max) * 100)) : 0}%`;
    track.append(fill);
    row.append(head, track);
    el.bars.append(row);
  }

  // 特別費は、グラフに混ぜず、書いた内容のまま1行ずつ
  el.specials.textContent = "";
  el.specials.hidden = wallet.specials.length === 0;
  for (const item of wallet.specials) {
    const row = node("div", "special");
    const left = node("span", "special__left");
    left.append(node("span", "tag", KIND.SPECIAL), node("span", "special__memo", item.memo || "(内容なし)"));
    row.append(left, node("span", "special__amount", yen(item.amount)));
    el.specials.append(row);
  }

  // 固定費は合計に入れるが、グラフには混ぜず、まとめて1行。貯蓄は「貯めたお金」として、合計に入れない。収入も1行
  el.extras.textContent = "";
  if (wallet.fixed.total > 0) el.extras.append(extraRow(MONTHLY.FIXED, joinNames(wallet.fixed.items), "", wallet.fixed.total));
  if (wallet.saving.total > 0) {
    el.extras.append(extraRow("貯めたお金", joinNames(wallet.saving.items), "（合計には入れていません）", wallet.saving.total));
  }
  if (wallet.income > 0) el.extras.append(extraRow("", "収入（手取り）", "", wallet.income));
  el.extras.hidden = el.extras.children.length === 0;

  el.walletDeposit.hidden = wallet.deposit === 0;
  el.walletDepositAmount.textContent = yen(wallet.deposit);
}

/** 'YYYY-MM' → '11月' */
function monthName(month) {
  return `${Number(month.split("-")[1])}月`;
}

/** 「来月、共同口座に入れる目安」。今月を見ているときだけ出す(来月 = きょうから見た来月なので) */
function renderEstimate(records) {
  const today = todayString();
  const show = state.month === today.slice(0, 7) && store.getMonthlyReady() === true;
  el.estimate.hidden = !show;
  if (!show) return;

  const e = estimateNextDeposit({ records, items: store.getMonthlyItems(), user: state.user, today });
  el.estimateTitle.textContent = `来月（${monthName(e.targetMonth)}）、共同口座に入れる目安`;

  el.estimateNums.textContent = "";
  if (e.need > 0) {
    delete el.estimateNums.dataset.tone;
    const half = node("span", "", "半々なら ");
    half.append(node("b", "", yen(e.half)));
    el.estimateNums.append(half);
    if (e.byIncome) {
      const ratio = node("span", "", "収入比なら ");
      ratio.append(node("b", "", yen(e.byIncome.amount)));
      el.estimateNums.append(ratio);
    }
  } else {
    el.estimateNums.dataset.tone = "none";
    el.estimateNums.textContent = "まだ計算できないにゃ。「毎月の設定」で、共同口座の固定費を入れてね。";
  }

  // 検算できるように、計算のもとを小さく出す
  el.estimateFormula.textContent =
    e.need > 0
      ? `必要額 ${yen(e.need)} ＝ 固定費 ${yen(e.fixed.total)} ＋ 変動費の平均 ${yen(e.variable.average)}（合わせて ${yen(e.raw)} を、1,000円単位に切り上げ）`
      : "";
  el.estimateFormula.hidden = e.need === 0;

  el.estimateList.textContent = "";
  const line = (label) => {
    const li = node("li");
    li.append(node("b", "", label));
    el.estimateList.append(li);
    return li;
  };
  const fixed = line("固定費: ");
  if (e.fixed.items.length === 0) fixed.append("共同口座の固定費の項目がありません");
  e.fixed.items.forEach((item, i) => {
    if (i > 0) fixed.append("、");
    if (item.source === "none") {
      const warn = node("span", "", `${item.name} 未入力`);
      warn.dataset.tone = "warn";
      fixed.append(warn);
    } else {
      fixed.append(`${item.name} ${yen(item.amount)}${item.source === "latest" ? `（${monthName(item.month)}の確定額）` : ""}`);
    }
  });
  const variable = line("変動費の平均: ");
  if (e.variable.basis === "none") {
    variable.append("共同口座の記録が、まだありません");
  } else {
    variable.append(
      e.variable.months
        .map((m) =>
          m.prorated
            ? `${monthName(m.month)} ${yen(m.amount)}（${m.days}日分の ${yen(m.actual)} を、1か月分に直した額）`
            : `${monthName(m.month)} ${yen(m.actual)}`
        )
        .join("、")
    );
    variable.append(
      e.variable.basis === "past"
        ? `${e.variable.months.length > 1 ? " の平均" : ""}。先月までの直近3か月で計算（今月は途中なので入れていません）。特別費は入れていません。`
        : "。先月までの記録がないので、今月の途中までで見積もっています。特別費は入れていません。"
    );
  }
  const ratio = line("収入比: ");
  ratio.append(
    e.byIncome
      ? `${monthName(e.byIncome.month)}に確定した、ふたりの手取りの比で分けた、${state.user}の分（1,000円単位）`
      : "ふたりとも「毎月の設定」で収入を確定すると、出るようになります"
  );
}

function detailMeta(record) {
  if (isAuto(record)) {
    // 確定した固定費・貯蓄は、日付ではなく「何月分か」を出す
    return `${monthName(recordMonth(record))}分・${record["財布"]}・${record["種類"]}`;
  }
  const date = isDateString(record["日付"]) ? formatDateShort(record["日付"]) : String(record["日付"] || "");
  if (record["種類"] === KIND.DEPOSIT) {
    return `${date}・${record["財布"]}の財布から`;
  }
  return `${date}・${record["財布"]}・${record["種類"]}`;
}

function renderDetails(details, pendingIds) {
  el.filterSelf.textContent = state.user;
  for (const button of el.filters) {
    button.setAttribute("aria-pressed", button.dataset.filter === state.filter ? "true" : "false");
  }

  const list = filterDetails(details, state.user, state.filter);
  const shown = state.expanded ? list : list.slice(0, DETAILS_FIRST);
  el.detailsNone.hidden = list.length > 0;
  el.list.textContent = "";
  for (const record of shown) {
    const editable = canEdit(record, state.user);
    const auto = isAuto(record);
    const row = node(editable || auto ? "button" : "div", "row");
    if (editable) {
      row.type = "button";
      row.dataset.id = record.id;
    } else if (auto) {
      // 確定した固定費・貯蓄は、ここでは直せない。押すと「毎月の設定」の、その月へ
      row.type = "button";
      row.dataset.monthly = recordMonth(record);
    }
    const main = node("span", "row__main");
    main.append(node("span", "row__label", labelOf(record)));
    const meta = node("span", "row__meta", detailMeta(record));
    if (auto) meta.append(node("span", "row__auto", "毎月の設定でなおす"));
    if (pendingIds.has(record.id)) meta.append(node("span", "row__pending", "送信待ち"));
    main.append(meta);
    row.append(main, node("span", "row__amount", yen(Number(record["金額"]) || 0)));
    const li = node("li", "details__item");
    li.append(row);
    el.list.append(li);
  }
  const rest = list.length - shown.length;
  el.more.hidden = rest <= 0;
  el.more.textContent = `のこり ${rest}件を見る`;
}

/** 画面全体を、いまのデータで出しなおす(修正の入力中の内容には、さわらない) */
function render() {
  const user = store.getUser();
  if (!user) return;
  const thisMonth = todayString().slice(0, 7);
  if (state.user !== user) {
    // 持ち主が変わった(登録し直した)ら、最初の状態に戻す
    state.user = user;
    state.month = thisMonth;
    state.filter = "all";
    state.expanded = false;
    closeEdit(false);
  }

  const saved = store.getRecords();
  const { records, pendingIds } = applyQueue(saved, queue.pendingOps(), user);
  state.records = records;

  const range = monthRange(records, user, thisMonth);
  if (!state.month || state.month < range.min) state.month = range.min;
  if (state.month > range.max) state.month = range.max;
  el.title.textContent = monthTitle(state.month);
  el.prev.disabled = state.month <= range.min;
  el.next.disabled = state.month >= range.max;

  const result = summarize(records, user, state.month);

  // 記録が1件もない月・読み込み前
  const neverLoaded = records.length === 0 && !store.getSyncedAt();
  let emptyText = "";
  if (neverLoaded && state.sync !== "ok") {
    emptyText = state.sync === "error" ? LINE.loadFailed : LINE.loading;
  } else if (result.count === 0) {
    emptyText = LINE.noMonth;
  }
  el.empty.hidden = !emptyText;
  el.emptyText.textContent = emptyText;
  el.cards.hidden = Boolean(emptyText);
  if (emptyText) return;

  renderJoint(result.joint);
  renderWallet(result.wallet);
  renderEstimate(records);
  renderDetails(result.details, pendingIds);
}

// --- 操作: 月・明細 ---------------------------------------------------------

function moveMonth(delta) {
  state.month = addMonth(state.month, delta);
  state.expanded = false;
  setNotice("");
  render();
}

function selectFilter(filter) {
  state.filter = filter;
  state.expanded = false;
  render();
}

/** カードの「明細を見る」: しぼりこんで、明細のカードまでスクロールする */
function jumpToDetails(filter) {
  selectFilter(filter);
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.details.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
}

// --- 操作: 修正 -------------------------------------------------------------

function setPressed(buttons, isOn) {
  for (const button of buttons) {
    button.setAttribute("aria-pressed", isOn(button) ? "true" : "false");
  }
}

function showEditError(text) {
  el.editError.hidden = !text;
  el.editError.textContent = text || "";
}

function clearEditInvalid() {
  for (const n of [el.editDate, el.editCategories, el.editMemo, el.editAmountBox]) {
    n.removeAttribute("data-invalid");
  }
  showEditError("");
}

function renderEditCategories() {
  const saved = store.getCategories();
  const list = (saved.length ? saved : DEFAULT_CATEGORIES).slice();
  // 取り込んだ記録などで、いまの一覧にないカテゴリが付いていたら、それも選べるようにする
  const original = state.editing && state.editing["種類"] === KIND.VARIABLE ? String(state.editing["項目"] || "") : "";
  if (original && !list.includes(original)) list.push(original);

  el.editCategories.textContent = "";
  for (const name of list) {
    const button = node("button", "choice choice--category");
    button.type = "button";
    button.dataset.category = name;
    button.setAttribute("aria-pressed", name === state.form.category ? "true" : "false");
    button.insertAdjacentHTML(
      "afterbegin",
      '<svg class="choice__paw" aria-hidden="true" width="15" height="15" fill="currentColor"><use href="#i-paw"></use></svg>'
    );
    button.append(node("span", "", name));
    el.editCategories.append(button);
  }
}

function renderEditKind() {
  const form = state.form;
  const deposit = form.kind === KIND.DEPOSIT;
  setPressed(el.editKinds, (b) => b.dataset.kind === form.kind);
  // 「共同へ入金」は、いつも自分の財布から(入力画面と同じ)
  setPressed(el.editWallets, (b) => b.dataset.wallet === (deposit ? "self" : form.wallet));
  for (const button of el.editWallets) {
    button.disabled = deposit && button.dataset.wallet !== "self";
  }
  el.editFieldCategory.hidden = form.kind !== KIND.VARIABLE;
  el.editFieldMemo.hidden = form.kind !== KIND.SPECIAL;
  el.editDepositNote.hidden = !deposit;
}

function setEditAmount(text) {
  const digits = digitsOnly(text).slice(0, MAX_AMOUNT_DIGITS);
  el.editAmount.value = digits ? formatAmount(Number(digits)) : "";
}

function openEdit(id) {
  const record = state.records.find((r) => r.id === id);
  if (!record || !canEdit(record, state.user)) return;

  state.editing = record;
  state.form = {
    wallet: record["財布"] === WALLET_JOINT ? "joint" : "self",
    kind: record["種類"],
    category: record["種類"] === KIND.VARIABLE ? String(record["項目"] || "") : "",
  };
  const from = record["元"] && record["元"] !== "アプリ" ? `${record["元"]}の記録` : "";
  const by = record["記録した人"] && record["記録した人"] !== state.user ? `${record["記録した人"]}が記録` : "";
  el.editMeta.textContent = [from, by].filter(Boolean).join("・");
  el.editMeta.hidden = !el.editMeta.textContent;
  el.editDate.value = isDateString(record["日付"]) ? record["日付"] : "";
  el.editWallets[0].textContent = state.user;
  el.editDepositNote.textContent = `${state.user}の財布から共同口座への入金として記録します。`;
  el.editMemo.value = record["種類"] === KIND.SPECIAL ? String(record["メモ"] || "") : "";
  setEditAmount(String(record["金額"] || ""));
  clearEditInvalid();
  renderEditCategories();
  renderEditKind();

  state.scrollTop = el.screen.scrollTop;
  el.main.hidden = true;
  el.edit.hidden = false;
  el.screen.scrollTop = 0;
}

function closeEdit(restoreScroll = true) {
  closeConfirm();
  if (!state.editing && el.edit.hidden) return;
  state.editing = null;
  state.form = null;
  el.edit.hidden = true;
  el.main.hidden = false;
  if (el.editAmount === document.activeElement || el.editMemo === document.activeElement) {
    document.activeElement.blur();
  }
  if (restoreScroll) el.screen.scrollTop = state.scrollTop;
}

function editInvalid(target, message, focusTarget) {
  target.setAttribute("data-invalid", "true");
  showEditError(message);
  if (focusTarget) focusTarget.focus();
}

/** 「なおす」: その場で確かめて、キューに積み、明細に戻る(通信は待たない) */
function saveEdit(event) {
  event.preventDefault();
  const original = state.editing;
  if (!original) return;
  clearEditInvalid();

  const form = state.form;
  const date = el.editDate.value;
  const memo = el.editMemo.value.trim();
  const digits = digitsOnly(el.editAmount.value);
  const amount = digits ? Number(digits) : 0;
  if (!isDateString(date)) {
    editInvalid(el.editDate, LINE.needDate, el.editDate);
    return;
  }
  if (form.kind === KIND.VARIABLE && !form.category) {
    editInvalid(el.editCategories, LINE.needCategory);
    return;
  }
  if (form.kind === KIND.SPECIAL && !memo) {
    editInvalid(el.editMemo, LINE.needMemo, el.editMemo);
    return;
  }
  if (!(amount > 0)) {
    editInvalid(el.editAmountBox, LINE.needAmount, el.editAmount);
    return;
  }

  const record = {
    id: original.id,
    日付: date,
    財布: form.kind === KIND.DEPOSIT || form.wallet === "self" ? state.user : WALLET_JOINT,
    種類: form.kind,
    項目: form.kind === KIND.VARIABLE ? form.category : "",
    メモ: form.kind === KIND.SPECIAL ? memo : "",
    金額: amount,
  };
  const changed = ["日付", "財布", "種類", "項目", "メモ", "金額"].some(
    (key) => String(record[key]) !== String(original[key] === undefined || original[key] === null ? "" : original[key])
  );
  if (changed) {
    if (!queue.enqueueUpdate(record)) {
      showEditError(LINE.storage);
      return;
    }
    setNotice(LINE.updated);
  }
  closeEdit();
  render();
}

// --- 操作: 削除(確認のダイアログ) ------------------------------------------

function openConfirm() {
  if (!state.editing) return;
  el.confirmWhat.textContent = describe(state.editing);
  el.confirm.hidden = false;
  el.confirmNo.focus();
}

function closeConfirm() {
  el.confirm.hidden = true;
}

function deleteEditing() {
  const record = state.editing;
  if (!record) return;
  closeConfirm();
  if (queue.cancel(record.id) === "failed") {
    showEditError(LINE.storage);
    return;
  }
  setNotice(LINE.deleted);
  closeEdit();
  render();
}

// --- 外から呼ぶもの ---------------------------------------------------------

/** 「見る」のタブを開いたとき: いつも今月から・明細の修正は閉じた状態で出す */
export function showView() {
  state.month = todayString().slice(0, 7);
  state.expanded = false;
  closeEdit(false);
  setNotice("");
  render();
}

/** 保存先から新しいデータが届いた・キューが変わったとき: 出ていれば出しなおす */
export function refreshView() {
  if (isShown()) render();
}

/** 裏での取得のようす(app.js から)。読み込み前の表示に使う */
export function setSyncState(value) {
  state.sync = value;
  if (isShown()) render();
}

/**
 * @param {object} [callbacks]
 * @param {(month: string) => void} [callbacks.openMonthly] 「毎月の設定」を、その月で開く
 */
export function initView(callbacks = {}) {
  hooks = { ...hooks, ...callbacks };
  el.prev.addEventListener("click", () => moveMonth(-1));
  el.next.addEventListener("click", () => moveMonth(1));
  for (const button of el.filters) {
    button.addEventListener("click", () => selectFilter(button.dataset.filter));
  }
  el.cards.addEventListener("click", (event) => {
    const jump = event.target.closest("[data-details]");
    if (jump) {
      jumpToDetails(jump.dataset.details);
      return;
    }
    const row = event.target.closest(".row[data-id]");
    if (row) {
      openEdit(row.dataset.id);
      return;
    }
    const auto = event.target.closest(".row[data-monthly]");
    if (auto) hooks.openMonthly(auto.dataset.monthly);
  });
  el.more.addEventListener("click", () => {
    state.expanded = true;
    render();
  });

  // 修正
  el.editBack.addEventListener("click", () => closeEdit());
  el.edit.addEventListener("submit", saveEdit);
  for (const button of el.editWallets) {
    button.addEventListener("click", () => {
      if (state.form.kind === KIND.DEPOSIT) return;
      state.form.wallet = button.dataset.wallet;
      renderEditKind();
    });
  }
  for (const button of el.editKinds) {
    button.addEventListener("click", () => {
      state.form.kind = button.dataset.kind;
      clearEditInvalid();
      renderEditKind();
    });
  }
  el.editCategories.addEventListener("click", (event) => {
    const button = event.target.closest("[data-category]");
    if (!button) return;
    state.form.category = button.dataset.category;
    el.editCategories.removeAttribute("data-invalid");
    setPressed(Array.from(el.editCategories.children), (b) => b.dataset.category === state.form.category);
  });
  el.editDate.addEventListener("change", () => el.editDate.removeAttribute("data-invalid"));
  el.editMemo.addEventListener("input", () => el.editMemo.removeAttribute("data-invalid"));
  el.editMemo.addEventListener("keydown", (event) => {
    // キーボードの「完了」では送信しない(「なおす」はボタンで押す)。変換中の Enter は無視
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      el.editMemo.blur();
    }
  });
  el.editAmount.addEventListener("input", () => {
    setEditAmount(el.editAmount.value);
    el.editAmountBox.removeAttribute("data-invalid");
  });
  el.editAmount.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      el.editAmount.blur();
    }
  });
  el.editAmountBox.addEventListener("click", () => el.editAmount.focus());

  // 削除
  el.editDelete.addEventListener("click", openConfirm);
  el.confirmNo.addEventListener("click", closeConfirm);
  el.confirmYes.addEventListener("click", deleteEditing);
  el.confirm.addEventListener("click", (event) => {
    if (event.target === el.confirm) closeConfirm(); // 外側を押したら閉じる
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !el.confirm.hidden) closeConfirm();
  });

  queue.subscribe((event) => {
    if (event.type === "change") {
      refreshView();
    } else if (event.type === "dropped" && event.op.op !== "add" && isShown()) {
      // 修正・削除が受けつけられなかった(相手がすでに消していた記録など)。app.js が最新を取り直す
      setNotice(LINE.dropped, "warn");
    } else if (event.type === "error" && event.code === "unknown_action" && isShown()) {
      // 保存先(GAS)が古い版で、この操作をまだ知らない。その操作だけ後回しになる(ほかは送られる)
      setNotice(LINE.needUpdate, "warn");
    }
  });
}
