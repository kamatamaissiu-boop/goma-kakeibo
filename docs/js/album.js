// 「ごまちゃんアルバム」画面(仕様書 4.4)。入力画面の写真の右上のカメラボタンから開く(下のタブには無い、4つ目の画面)。
//
//   - 3列のグリッド。先頭が「写真を足す」。端末の写真を、まとめて何枚でもえらべる(パソコンのブラウザからも足せる)。
//   - 足した写真は、送り終わるのを待たずに、その場で出す。送信中・送れていない写真には、小さく印を出す。
//   - 写真を長押しすると、確認のうえで外せる(パソコンでは右クリックか、えらんで Delete キーでも)。
//   - 写真のデータ(保存・送信・取得)は photos.js が受け持つ。ここは画面だけ。
//   - 保存先(GAS)が古い版のあいだは、「保存先の更新が必要にゃ」と出すだけ(足すボタンは押せない)。

import * as photos from "./photos.js";
import * as store from "./store.js";

/** 長押しと見なすまでの時間 */
const LONG_PRESS_MS = 550;
/** 長押しのあいだに、指がこれ以上動いたら、スクロールと見なしてやめる */
const MOVE_LIMIT_PX = 10;
/** 確認のダイアログが出た直後の、うっかり押しを無視する時間 */
const DIALOG_GUARD_MS = 400;

const LINE = Object.freeze({
  needUpdate: "保存先の更新が必要にゃ。",
  needUpdateNote: "スプレッドシートの Apps Script を新しい版にすると、アルバムが使えるようになります。入力と「見る」は、いままでどおり使えます。",
  preparing: (done, total) => `写真を準備しているにゃ…（${done}/${total}）`,
  sending: (n) => `${n}枚を送っているにゃ…（このまま閉じても、あとで送ります）`,
  failed: (n) => `送れていない写真が ${n}枚あるにゃ。電波のよいところで、もういちど送ってね。`,
  waitingUpdate: (n) => `保存先の更新が必要にゃ。${n}枚は、この端末に取っておくにゃ（更新のあとで、自動で送ります）。`,
  unreadable: (n) => `${n}枚は、読めない形式だったので、とばしたにゃ。`,
  saveFailed: (n) => `${n}枚は、この端末に保存できなかったにゃ…。空き容量や、プライベートブラウズになっていないかを見てみてね。`,
  removed: "はずしたにゃ。",
  droppedLarge: "ごめんにゃ、1枚は大きすぎて、保存先に受けつけてもらえなかったにゃ。",
  droppedFull: "アルバムがいっぱいにゃ。どれかをはずしてから、もういちど足してね。",
  dropped: "ごめんにゃ、1枚だけ保存先に受けつけてもらえなかったにゃ。",
  empty: "まだ写真がないにゃ。「写真を足す」から、ごまちゃんの写真を入れてね。",
  hint: "写真を長押しすると、はずせます",
});

const $ = (id) => document.getElementById(id);

const el = {
  view: $("view-album"),
  back: $("album-back"),
  notice: $("album-notice"),
  status: $("album-status"),
  statusText: $("album-status-text"),
  retry: $("album-retry"),
  grid: $("album-grid"),
  add: $("album-add"),
  file: $("album-file"),
  hint: $("album-hint"),
  confirm: $("photo-confirm"),
  confirmImg: $("photo-confirm-img"),
  confirmNo: $("photo-confirm-no"),
  confirmYes: $("photo-confirm-yes"),
};

const state = {
  preparing: null,   // 写真を準備している最中: { done, total }
  notice: { text: "", tone: "" },
  removeId: "",      // 確認のダイアログに出している写真
  confirmAt: 0,      // ダイアログを出した時刻
  press: null,       // 長押しの途中: { id, x, y, timer }
  pressFired: false, // 長押しが成立した直後(つづく click を無視する)
};

/** タイル(id → 要素)。出しなおしても、同じ写真の <img> は作り直さない(ちらつかせない) */
const tiles = new Map();

let hooks = { back() {} };

function isShown() {
  return !el.view.hidden;
}

function setNotice(text, tone = "") {
  state.notice = { text, tone };
  renderStatus();
}

// --- 表示 -------------------------------------------------------------------

function makeTile(id) {
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = "tile";
  tile.dataset.id = id;
  const img = document.createElement("img");
  img.className = "tile__img";
  img.alt = "";
  img.draggable = false;
  img.decoding = "async";
  img.hidden = true;
  // まだ届いていない写真の場所に出す肉球
  tile.insertAdjacentHTML(
    "afterbegin",
    '<svg class="tile__paw" aria-hidden="true" width="28" height="28" fill="currentColor"><use href="#i-paw"></use></svg>'
  );
  const badge = document.createElement("span");
  badge.className = "tile__badge";
  badge.hidden = true;
  tile.append(img, badge);
  return tile;
}

function paintTile(tile, photo) {
  const img = tile.querySelector(".tile__img");
  const badge = tile.querySelector(".tile__badge");
  tile.dataset.state = photo.state;
  tile.toggleAttribute("data-loading", !photo.local);
  const label =
    photo.state === "sending" ? "送信中…" : photo.state === "waiting" ? "送信待ち" : photo.state === "failed" ? "送れていません" : "";
  badge.hidden = !label;
  badge.textContent = label;
  tile.setAttribute("aria-label", `ごまちゃんの写真${label ? `（${label}）` : ""}。長押しで、はずせます`);
  if (photo.local && img.hidden && !tile.dataset.loadingUrl) {
    tile.dataset.loadingUrl = "1";
    photos.getUrl(photo.id).then((url) => {
      delete tile.dataset.loadingUrl;
      if (!url) return;
      img.src = url;
      img.hidden = false;
    });
  }
}

function renderGrid() {
  const list = photos.listPhotos();
  const ids = new Set(list.map((p) => p.id));
  for (const [id, tile] of tiles) {
    if (!ids.has(id)) {
      tile.remove();
      tiles.delete(id);
    }
  }
  let before = el.add.nextSibling;
  for (const photo of list) {
    let tile = tiles.get(photo.id);
    if (!tile) {
      tile = makeTile(photo.id);
      tiles.set(photo.id, tile);
    }
    paintTile(tile, photo);
    if (tile !== before) {
      el.grid.insertBefore(tile, before);
    } else {
      before = before.nextSibling;
    }
  }
  el.hint.textContent = list.length === 0 ? LINE.empty : LINE.hint;
  el.hint.toggleAttribute("data-empty", list.length === 0);
}

function renderStatus() {
  const old = store.getPhotosReady() === false;
  const list = photos.listPhotos();
  const failed = list.filter((p) => p.state === "failed").length;
  const sending = list.filter((p) => p.state === "sending" || p.state === "waiting").length;

  // 「写真を足す」: 保存先が古い版のあいだと、準備の最中は、押せない
  const disabled = old || Boolean(state.preparing);
  el.file.disabled = disabled;
  el.add.toggleAttribute("data-disabled", disabled);

  // 上の一言(とばした・はずした・保存先の更新が必要)
  let text = state.notice.text;
  let tone = state.notice.tone;
  if (old) {
    text = `${LINE.needUpdate}\n${LINE.needUpdateNote}`;
    tone = "warn";
  }
  el.notice.hidden = !text;
  el.notice.textContent = text;
  if (tone) {
    el.notice.dataset.tone = tone;
  } else {
    delete el.notice.dataset.tone;
  }

  // 送信のようす
  let status = "";
  let canRetry = false;
  let warn = false;
  if (state.preparing) {
    status = LINE.preparing(state.preparing.done, state.preparing.total);
  } else if (failed > 0 && photos.needsUpdate()) {
    status = LINE.waitingUpdate(failed);
    warn = true;
  } else if (failed > 0) {
    status = LINE.failed(failed);
    canRetry = true;
    warn = true;
  } else if (sending > 0) {
    status = LINE.sending(sending);
  }
  el.status.hidden = !status;
  el.statusText.textContent = status;
  el.retry.hidden = !canRetry;
  el.status.toggleAttribute("data-warn", warn);
}

function render() {
  renderGrid();
  renderStatus();
}

// --- 操作: 足す ---------------------------------------------------------------

async function onFiles() {
  const files = Array.from(el.file.files || []);
  // 同じ写真をもういちどえらんでも、反応するように
  el.file.value = "";
  if (files.length === 0 || state.preparing) return;

  state.preparing = { done: 0, total: files.length };
  setNotice("");
  let result;
  try {
    result = await photos.addFiles(files, (done, total) => {
      state.preparing = { done, total };
      renderStatus();
    });
  } finally {
    state.preparing = null;
  }
  const lines = [];
  if (result.unreadable > 0) lines.push(LINE.unreadable(result.unreadable));
  if (result.failed > 0) lines.push(LINE.saveFailed(result.failed));
  setNotice(lines.join("\n"), lines.length ? "warn" : "");
  render();
}

// --- 操作: 外す(長押し → 確認のダイアログ) -----------------------------------

function cancelPress() {
  if (!state.press) return;
  clearTimeout(state.press.timer);
  state.press = null;
}

function openConfirm(id) {
  cancelPress();
  if (!photos.listPhotos().some((p) => p.id === id)) return;
  state.removeId = id;
  state.confirmAt = Date.now();
  el.confirmImg.hidden = true;
  el.confirmImg.removeAttribute("src");
  photos.getUrl(id).then((url) => {
    if (state.removeId !== id || !url) return;
    el.confirmImg.src = url;
    el.confirmImg.hidden = false;
  });
  el.confirm.hidden = false;
  el.confirmNo.focus();
}

function closeConfirm() {
  if (el.confirm.hidden) return;
  const id = state.removeId;
  state.removeId = "";
  el.confirm.hidden = true;
  // もとの写真にフォーカスを戻す(キーボードで使っているとき)
  const tile = tiles.get(id);
  if (tile && isShown()) tile.focus({ preventScroll: true });
}

function guarded() {
  return Date.now() - state.confirmAt < DIALOG_GUARD_MS;
}

async function removeConfirmed() {
  if (guarded()) return;
  const id = state.removeId;
  if (!id) return;
  closeConfirm();
  await photos.removePhotoById(id);
  setNotice(LINE.removed);
  render();
}

// --- 外から呼ぶもの ---------------------------------------------------------

/** アルバムを開いたとき: いまある分をすぐ出して、まだ端末に無い写真を取りに行く */
export function showAlbum() {
  closeConfirm();
  cancelPress();
  state.notice = { text: "", tone: "" };
  render();
  photos.initPhotos().then(() => {
    if (!isShown()) return;
    render();
    photos.ensureAll();
    photos.flush();
  });
}

/** 保存先から新しい一覧が届いたとき: 出ていれば、出しなおして、足りない写真を取りに行く */
export function refreshAlbum() {
  if (!isShown()) return;
  render();
  photos.ensureAll();
}

/**
 * @param {object} callbacks
 * @param {() => void} callbacks.back 入力画面にもどる
 */
export function initAlbum(callbacks = {}) {
  hooks = { ...hooks, ...callbacks };

  el.back.addEventListener("click", () => hooks.back());
  el.file.addEventListener("change", onFiles);
  el.retry.addEventListener("click", () => photos.retry());

  // 長押し(指・マウス・ペン)。動いたら・離したら、やめる
  el.grid.addEventListener("pointerdown", (event) => {
    const tile = event.target.closest(".tile");
    cancelPress();
    state.pressFired = false;
    if (!tile || (event.pointerType === "mouse" && event.button !== 0)) return;
    const id = tile.dataset.id;
    state.press = {
      id,
      x: event.clientX,
      y: event.clientY,
      timer: setTimeout(() => {
        state.press = null;
        state.pressFired = true;
        openConfirm(id);
      }, LONG_PRESS_MS),
    };
  });
  el.grid.addEventListener("pointermove", (event) => {
    const p = state.press;
    if (p && Math.hypot(event.clientX - p.x, event.clientY - p.y) > MOVE_LIMIT_PX) cancelPress();
  });
  for (const type of ["pointerup", "pointercancel", "pointerleave"]) {
    el.grid.addEventListener(type, cancelPress);
  }
  el.view.closest(".screen").addEventListener("scroll", cancelPress, { passive: true });

  // 右クリック(パソコン)・長押しのメニュー(Android)。ブラウザのメニューは出さずに、外すかを聞く
  el.grid.addEventListener("contextmenu", (event) => {
    const tile = event.target.closest(".tile");
    if (!tile) return;
    event.preventDefault();
    if (el.confirm.hidden) openConfirm(tile.dataset.id);
  });
  // キーボード: 写真をえらんで Delete / Backspace
  el.grid.addEventListener("keydown", (event) => {
    const tile = event.target.closest(".tile");
    if (tile && (event.key === "Delete" || event.key === "Backspace")) {
      event.preventDefault();
      openConfirm(tile.dataset.id);
    }
  });
  el.grid.addEventListener("click", (event) => {
    const tile = event.target.closest(".tile");
    if (!tile) return;
    if (state.pressFired) {
      state.pressFired = false;
      return;
    }
    // 送れていない写真を押したら、送り直す
    if (tile.dataset.state === "failed" && !photos.needsUpdate()) photos.retry();
  });
  // 写真の上では、文字えらびや、画像のドラッグを始めさせない
  el.grid.addEventListener("dragstart", (event) => event.preventDefault());

  el.confirmNo.addEventListener("click", closeConfirm);
  el.confirmYes.addEventListener("click", removeConfirmed);
  el.confirm.addEventListener("click", (event) => {
    if (event.target === el.confirm && !guarded()) closeConfirm(); // 外側を押したら閉じる
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !el.confirm.hidden) closeConfirm();
  });

  photos.subscribe((event) => {
    if (event.type === "dropped") {
      state.notice = {
        text: event.reason === "too_large" ? LINE.droppedLarge : event.reason === "full" ? LINE.droppedFull : LINE.dropped,
        tone: "warn",
      };
    }
    if (!isShown()) return;
    if (event.type === "change" || event.type === "dropped") {
      // 外そうとしていた写真が、もう無い(相手が先に外した等)なら、ダイアログを閉じる
      if (state.removeId && !photos.listPhotos().some((p) => p.id === state.removeId)) closeConfirm();
      render();
    } else if (event.type === "error") {
      renderStatus();
    }
  });
}
