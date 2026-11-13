// ごまちゃん家計簿 画面の入口。
//   - どの画面を出すかを決める(入力 / 見る / 毎月の設定 / 合言葉)
//   - 合言葉の登録
//   - 裏での同期(最新データの取得)と、未送信キューを送り直す合図
//   - Service Worker の登録

import { ApiError, isConfigured, login, sync } from "./api.js";
import { APP_VERSION } from "./config.js";
import { initInput, onHide, onResume, refreshData, showInput } from "./input.js";
import * as queue from "./queue.js";
import * as store from "./store.js";
import { initMonthly, refreshMonthly, setMonthlyMonth, setMonthlySyncState, showMonthly } from "./monthly.js";
import { initView, setSyncState, showView } from "./view.js";

// --- 画面の部品 -------------------------------------------------------------

const el = {
  views: {
    input: document.getElementById("view-input"),
    view: document.getElementById("view-view"),
    login: document.getElementById("view-login"),
    monthly: document.getElementById("view-monthly"),
  },
  status: document.getElementById("connect-status"),
  form: document.getElementById("login-form"),
  input: document.getElementById("aikotoba"),
  button: document.getElementById("login-button"),
  buttonText: document.getElementById("login-button-text"),
  about: document.getElementById("about-status"),
  forget: document.getElementById("forget-button"),
  tabs: Array.from(document.querySelectorAll(".tab")),
  tabBar: document.getElementById("tabs"),
  screen: document.getElementById("screen"),
};

const BUTTON_IDLE = "はじめる";
const BUTTON_BUSY = "たしかめています…";
/** 合言葉の画面の、ふだんの状態の1行。空 = 出さない(「きくのは、さいしょの1回だけ」は、いつも下に出ている) */
const LOGIN_PROMPT = "";
/** 画面に戻ってきたとき、前回の同期からこの時間がたっていたら取り直す */
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

let currentTab = "input";
let lastSyncAt = 0;
let syncing = false;
let resyncNeeded = false; // 取りに行っているあいだに送信が終わった → 取り直す(古い内容で上書きしないように)

function isLoggedIn() {
  return Boolean(store.getAikotoba() && store.getUser());
}

// --- 表示の切り替え ---------------------------------------------------------

/** いまのタブと登録の状態から、出す画面を1つ決める */
function render() {
  let name;
  if (!isLoggedIn()) {
    name = "login";
  } else if (currentTab === "monthly") {
    name = "monthly";
    renderAbout();
  } else if (currentTab === "view") {
    name = "view";
  } else {
    name = "input";
    showInput();
  }
  for (const [key, view] of Object.entries(el.views)) {
    view.hidden = key !== name;
  }
  // 合言葉の画面では、下のタブを出さない(登録するまで、ほかの画面は開けないので)
  el.tabBar.hidden = name === "login";
  // 「見る」「毎月の設定」は、見えるようにしてから中身を作る
  if (name === "view") {
    showView();
  } else if (name === "monthly") {
    showMonthly();
  }
}

/** 「毎月の設定」のいちばん下の、この iPhone のこと(登録・未送信・版) */
function renderAbout() {
  const pending = queue.pendingCount();
  const lines = [`${store.getUser()}のiPhoneとして登録済みです。`];
  if (pending > 0) {
    lines.push(
      queue.needsUpdate()
        ? `まだ送れていない記録が ${pending}件あります(保存先の更新が必要なものがあります)。`
        : `まだ送れていない記録が ${pending}件あります(自動で送り直します)。`
    );
  }
  lines.push(`版 ${APP_VERSION}`);
  el.about.textContent = lines.join("\n");
  el.forget.hidden = false;
}

function selectTab(name) {
  currentTab = name;
  for (const tab of el.tabs) {
    if (tab.dataset.tab === name) {
      tab.setAttribute("aria-current", "page");
    } else {
      tab.removeAttribute("aria-current");
    }
  }
  render();
  el.screen.scrollTop = 0;
}

/** 合言葉の画面の、状態の1行(空なら出さない)。tone: "" | "warn" */
function setStatus(text, tone = "") {
  el.status.hidden = !text;
  el.status.textContent = text;
  if (tone) {
    el.status.dataset.tone = tone;
  } else {
    delete el.status.dataset.tone;
  }
  el.input.setAttribute("aria-invalid", tone === "warn" ? "true" : "false");
}

function setBusy(busy) {
  el.button.disabled = busy;
  el.input.readOnly = busy;
  el.buttonText.textContent = busy ? BUTTON_BUSY : BUTTON_IDLE;
}

/** 失敗の理由を、やさしい言葉にする */
function messageFor(err) {
  const code = err instanceof ApiError ? err.code : "unknown";
  switch (code) {
    case "auth":
      return "合言葉がちがうみたいにゃ。もういちど、ゆっくり入れてみてね。";
    case "locked":
      return "少し時間をおいてにゃ。まちがいが続いたので、10分ほどお休みしています。";
    case "network":
      return "いまは保存先に届きませんでした。電波のよいところで、もういちど試してみてね。";
    case "setup":
      return "保存先の準備がまだ終わっていないようです(スプレッドシートの「初期設定」と「合言葉を設定」)。";
    case "bad_response":
      return "保存先から思っていない返事が来ました。GAS のデプロイ設定(アクセスできるユーザー: 全員)を確認してください。";
    case "busy":
      return "保存先が混みあっています。少し待って、もういちど試してみてね。";
    default:
      return "保存先でうまくいきませんでした。少し待って、もういちど試してみてね。";
  }
}

// --- 合言葉 -----------------------------------------------------------------

/** 入力された合言葉をたしかめて、通ればこの iPhone に覚えさせ、入力画面へ進む */
async function submitAikotoba(event) {
  event.preventDefault();
  const aikotoba = el.input.value.trim();
  if (!aikotoba) {
    setStatus("合言葉を入れてね。", "warn");
    el.input.focus();
    return;
  }

  setBusy(true);
  setStatus("たしかめています…");
  try {
    const result = await login(aikotoba);
    if (!store.saveLogin({ aikotoba, user: result.user, categories: result.categories })) {
      setStatus("この iPhone に覚えさせられませんでした。プライベートブラウズになっていないか見てみてね。", "warn");
      return;
    }
    el.input.value = "";
    el.input.blur();
    setStatus(LOGIN_PROMPT);
    selectTab("input");
    // 裏で: 前に送れなかった記録を送り、最新のデータを取る
    queue.flush();
    syncNow();
  } catch (err) {
    setStatus(messageFor(err), "warn");
    if (err instanceof ApiError && err.code === "auth") {
      el.input.select();
    }
  } finally {
    setBusy(false);
  }
}

/** 覚えていた合言葉が通らなくなったとき(合言葉が変えられた場合など): 入れ直してもらう */
function handleAuthLost() {
  if (!isLoggedIn()) return;
  store.clearLogin();
  setStatus("合言葉が変わったみたいにゃ。新しい合言葉を入れてね。", "warn");
  render();
}

function forgetLogin() {
  const pending = queue.pendingCount();
  const note = pending > 0 ? `\nまだ送れていない記録が ${pending}件あります。同じ人の合言葉を入れ直すと、あとで送られます。` : "";
  if (!window.confirm(`この iPhone の登録をやり直しますか?(合言葉をもういちど入れます)${note}`)) {
    return;
  }
  store.clearLogin();
  setStatus(LOGIN_PROMPT);
  selectTab("input");
  el.input.focus();
}

// --- 裏での同期 -------------------------------------------------------------

/**
 * 最新のデータ(カテゴリ・記録の一覧)を取って、端末に保存する。
 * 画面は前回のデータで先に出してあるので、失敗しても何も止めない。
 */
async function syncNow() {
  if (syncing || !isConfigured() || !isLoggedIn()) return;
  syncing = true;
  resyncNeeded = false;
  setSyncState("loading");
  let state = "error";
  const aikotoba = store.getAikotoba();
  try {
    let result;
    try {
      result = await sync();
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== "unknown_action") throw err;
      // 保存先(GAS)がまだ古い版のとき: カテゴリだけでも取り直す
      result = await login(aikotoba);
    }
    // 取りに行っているあいだに登録がやり直されていたら、結果は捨てる
    if (store.getAikotoba() !== aikotoba) return;

    const userChanged = result.user !== store.getUser();
    store.saveLogin({ aikotoba, user: result.user, categories: result.categories });
    if (applyServerData(result)) {
      state = "ok";
    }
    lastSyncAt = Date.now();
    if (userChanged) {
      render();
    } else {
      refreshData();
      refreshMonthly();
    }
  } catch (err) {
    if (err instanceof ApiError && err.code === "auth") {
      handleAuthLost();
    }
    // 電波がない・ロック中などは、前回のデータのまま使いつづける
  } finally {
    syncing = false;
    setSyncState(state); // 「見る」が出ていれば、ここで出しなおされる
    setMonthlySyncState(state);
    if (resyncNeeded) {
      resyncNeeded = false;
      syncNow();
    }
  }
}

/**
 * 保存先から返ってきた中身(sync や、月の確定の応答)を、端末に保存する。
 * @returns {boolean} 記録の一覧が入っていたか
 */
function applyServerData(result) {
  if (!result || !Array.isArray(result.records)) return false;
  // 取り消しを送っている途中の記録は、一覧に戻さない
  const deleting = queue.pendingDeleteIds();
  store.setRecords(result.records.filter((r) => !deleting.includes(r.id)));
  store.markSynced();
  // 毎月の項目が入っていなければ、保存先(GAS)が古い版(「毎月の設定」は、更新されるまで使えない)
  const ready = Array.isArray(result.monthlyItems);
  store.setMonthlyReady(ready);
  if (ready) {
    store.setMonthlyData(result.monthlyItems, result.monthlyClosed);
  }
  return true;
}

/** アプリに戻ってきた・電波が戻った: 未送信を送り直し、古くなっていれば取り直す */
function wake() {
  if (!isConfigured() || !isLoggedIn()) return;
  queue.flush();
  if (Date.now() - lastSyncAt > SYNC_INTERVAL_MS) {
    syncNow();
  }
}

// --- Service Worker(アプリの殻を端末に保存して、すぐ開けるようにする) -------

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  // 新しい版の Service Worker に切り替わったら、1回だけ読み込み直して新しい画面にする。
  // (初めて開いたときは、切り替わっても読み込み直さない)
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    window.location.reload();
  });

  window.addEventListener("load", () => {
    // 相対パスで登録する(GitHub Pages のようにサブパスで配信されても動くように)
    navigator.serviceWorker.register("./sw.js").catch((err) => {
      console.warn("Service Worker を登録できませんでした", err);
    });
    // 殻の保存が終わって動きだしたら、ごまちゃんの絵を裏でまとめて保存してもらう(2回目からは通信なしで出る)。
    // すでに保存してある絵は、取り直さない
    navigator.serviceWorker.ready
      .then((registration) => {
        if (registration.active) registration.active.postMessage({ type: "cache-art" });
      })
      .catch(() => {});
  });
}

// --- 起動 -------------------------------------------------------------------

// いちばん先に登録する。新しい版に入れ替わる途中で、HTML と JS の版がずれて下の処理が止まっても、
// 入れ替わりしだい読み込み直して、新しい画面にそろうように
registerServiceWorker();

initInput();
initView({
  // 明細の、確定した固定費などを押したとき: 「毎月の設定」を、その月で開く
  openMonthly(month) {
    setMonthlyMonth(month);
    selectTab("monthly");
  },
});
initMonthly({
  applyServerData(result) {
    applyServerData(result);
    lastSyncAt = Date.now();
    // 同期の途中だったら、その結果は確定の前の内容かもしれないので、取り直す
    if (syncing) resyncNeeded = true;
    refreshData();
  },
  onAuthLost: handleAuthLost,
  requestSync: syncNow,
});
el.form.addEventListener("submit", submitAikotoba);
el.forget.addEventListener("click", forgetLogin);
for (const tab of el.tabs) {
  tab.addEventListener("click", () => selectTab(tab.dataset.tab));
}

queue.subscribe((event) => {
  if (event.type === "error" && event.code === "auth") {
    handleAuthLost();
  } else if (event.type === "sent" && syncing) {
    resyncNeeded = true;
  } else if (event.type === "dropped") {
    // 受けつけてもらえなかった操作があった(相手の記録だった等)。端末の一覧を、保存先の内容に合わせ直す
    if (syncing) {
      resyncNeeded = true;
    } else {
      syncNow();
    }
  }
  if (event.type === "change" && currentTab === "monthly" && isLoggedIn()) {
    renderAbout();
  }
});

window.addEventListener("online", wake);
window.addEventListener("pageshow", (event) => {
  if (event.persisted) wake();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    onResume();
    wake();
  } else {
    onHide();
  }
});

if (!isConfigured()) {
  setStatus("まだ保存先とつながっていません", "warn");
  el.form.hidden = true;
} else {
  setStatus(LOGIN_PROMPT);
}

// 登録済みなら、端末に保存してある前回のデータで、すぐ入力画面を出す。最新は裏で取りに行く
render();
if (isConfigured() && isLoggedIn()) {
  queue.flush();
  syncNow();
}
