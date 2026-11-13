// ごまちゃん家計簿 画面の入口(段階0: 準備中の画面と、保存先との接続テスト)

import { ApiError, isConfigured, login } from "./api.js";
import * as store from "./store.js";

// --- 画面の部品 -------------------------------------------------------------

const el = {
  screenTitle: document.getElementById("screen-title"),
  gomaLine: document.getElementById("goma-line"),
  status: document.getElementById("connect-status"),
  form: document.getElementById("login-form"),
  input: document.getElementById("aikotoba"),
  button: document.getElementById("login-button"),
  buttonText: document.getElementById("login-button-text"),
  forget: document.getElementById("forget-button"),
  tabs: Array.from(document.querySelectorAll(".tab")),
};

const TAB_TITLES = { input: "入力", view: "見る", monthly: "毎月の設定" };
const LINE_DEFAULT = "もうすぐ使えるようになるにゃ。";
const BUTTON_IDLE = "この iPhone を登録する";
const BUTTON_BUSY = "たしかめています…";

// --- 表示の切り替え ---------------------------------------------------------

/** つながりの状態を1行で出す。tone: "" | "ok" | "warn" */
function setStatus(text, tone = "") {
  el.status.textContent = text;
  if (tone) {
    el.status.dataset.tone = tone;
  } else {
    delete el.status.dataset.tone;
  }
}

/** 合言葉の入力欄を出す */
function showLoginForm(message, tone = "") {
  setStatus(message, tone);
  el.form.hidden = false;
  el.forget.hidden = true;
  el.input.setAttribute("aria-invalid", tone === "warn" ? "true" : "false");
}

/** 登録済みの表示にする */
function showRegistered(message) {
  setStatus(message, "ok");
  el.form.hidden = true;
  el.forget.hidden = false;
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

/** 入力された合言葉をたしかめて、通ればこの iPhone に覚えさせる */
async function submitAikotoba(event) {
  event.preventDefault();
  const aikotoba = el.input.value.trim();
  if (!aikotoba) {
    showLoginForm("合言葉を入れてね。", "warn");
    el.input.focus();
    return;
  }

  setBusy(true);
  setStatus("たしかめています…");
  try {
    const result = await login(aikotoba);
    store.saveLogin({ aikotoba, user: result.user, categories: result.categories });
    el.input.value = "";
    el.input.blur();
    showRegistered(`${result.user}のiPhoneとして登録したにゃ`);
  } catch (err) {
    showLoginForm(messageFor(err), "warn");
    if (err instanceof ApiError && err.code === "auth") {
      el.input.select();
    }
  } finally {
    setBusy(false);
  }
}

/** 覚えている合言葉が、いまも通るかを裏でたしかめる(画面は先に出しておく) */
async function recheckSavedLogin() {
  const aikotoba = store.getAikotoba();
  try {
    const result = await login(aikotoba);
    store.saveLogin({ aikotoba, user: result.user, categories: result.categories });
    showRegistered(`${result.user}のiPhoneとして登録済みです。保存先ともつながっています。`);
  } catch (err) {
    if (err instanceof ApiError && err.code === "auth") {
      // 合言葉が変えられた場合など。覚えていた分を消して、入れ直してもらう
      store.clearLogin();
      showLoginForm("合言葉が変わったみたいにゃ。新しい合言葉を入れてね。", "warn");
    } else {
      // 電波がないだけ、などの場合は登録を消さない
      setStatus(`${store.getUser()}のiPhoneとして登録済みです。(${messageFor(err)})`, "warn");
    }
  }
}

function forgetLogin() {
  if (!window.confirm("この iPhone の登録をやり直しますか?(合言葉をもういちど入れます)")) {
    return;
  }
  store.clearLogin();
  showLoginForm("合言葉を入れてね。さいしょの1回だけでだいじょうぶ。");
  el.input.focus();
}

/** 起動時: 保存先とのつながりを判定して、出すものを決める */
function initConnection() {
  if (!isConfigured()) {
    setStatus("まだ保存先とつながっていません", "warn");
    el.form.hidden = true;
    el.forget.hidden = true;
    return;
  }

  if (store.getAikotoba() && store.getUser()) {
    // 2回目以降は、合言葉を聞かずに通す
    showRegistered(`${store.getUser()}のiPhoneとして登録済みです。`);
    recheckSavedLogin();
  } else {
    showLoginForm("合言葉を入れてね。さいしょの1回だけでだいじょうぶ。");
  }
}

// --- 下のタブ(段階0では見た目だけ) ----------------------------------------

function selectTab(name) {
  for (const tab of el.tabs) {
    if (tab.dataset.tab === name) {
      tab.setAttribute("aria-current", "page");
    } else {
      tab.removeAttribute("aria-current");
    }
  }
  el.screenTitle.textContent = TAB_TITLES[name] || "";
  el.gomaLine.textContent = LINE_DEFAULT;
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
  });
}

// --- 起動 -------------------------------------------------------------------

el.form.addEventListener("submit", submitAikotoba);
el.forget.addEventListener("click", forgetLogin);
for (const tab of el.tabs) {
  tab.addEventListener("click", () => selectTab(tab.dataset.tab));
}

initConnection();
registerServiceWorker();
