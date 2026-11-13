// 保存先(Google Apps Script の Web アプリ)との通信。
//
// 送り方: POST / Content-Type: text/plain / 本文は JSON 文字列
//   { "action": "login", "合言葉": "…", …その action に必要な値 }
//   ※ text/plain にするのは、ブラウザの事前確認(CORS プリフライト)を避けるため。
//     GAS は OPTIONS に応答できないので、application/json だと通信できない。
// 返り方: JSON
//   成功 { "ok": true, … }   失敗 { "ok": false, "error": "auth" など }

import { GAS_URL, API_TIMEOUT_MS } from "./config.js";
import { getAikotoba } from "./store.js";

/**
 * 通信の失敗。code で理由を見分ける。
 *   not_configured … GAS_URL が空
 *   network        … 電波がない・時間切れなど、保存先に届かなかった
 *   bad_response   … 届いたが JSON ではなかった(デプロイ設定の間違いなど)
 *   auth           … 合言葉がちがう
 *   setup          … スプレッドシート側の初期設定・合言葉設定がまだ
 *   locked         … 合言葉の間違いが続いたので、しばらく受け付けを止めている(10分ほどで戻る)
 *   busy           … 同時書き込みで順番待ちが時間切れ
 *   invalid        … 送った内容がおかしい(金額が 0 など)。送り直しても通らない
 *   forbidden      … 相手の財布の記録なので、なおしたり消したりできない
 *   unknown_action … 保存先(GAS)が古い版のまま。貼り直しとデプロイが必要
 *   それ以外       … サーバー側のエラー(server / bad_request)
 */
export class ApiError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "ApiError";
    this.code = code;
  }
}

/** 保存先の URL が設定されているか */
export function isConfigured() {
  return typeof GAS_URL === "string" && GAS_URL.trim() !== "";
}

/**
 * API を1回呼ぶ。
 * @param {string} action   例: "login"
 * @param {object} [params] その action に必要な値
 * @param {object} [options]
 * @param {string} [options.aikotoba] 合言葉(省略時は端末に覚えているもの)
 * @returns {Promise<object>} ok:true の応答
 */
export async function callApi(action, params = {}, options = {}) {
  if (!isConfigured()) {
    throw new ApiError("not_configured");
  }
  const aikotoba = options.aikotoba ?? getAikotoba();
  const body = JSON.stringify({ ...params, action, 合言葉: aikotoba });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(GAS_URL.trim(), {
      method: "POST",
      // GAS は script.googleusercontent.com へ転送(302)して結果を返すので、たどる
      redirect: "follow",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body,
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
    });
  } catch (err) {
    throw new ApiError("network", String(err && err.message));
  } finally {
    clearTimeout(timer);
  }

  let data;
  try {
    data = JSON.parse(await response.text());
  } catch {
    // ログイン画面の HTML が返ってきた場合など(アクセス権が「全員」になっていない等)
    throw new ApiError("bad_response", `HTTP ${response.status}`);
  }

  if (!data || data.ok !== true) {
    throw new ApiError((data && data.error) || "server");
  }
  return data;
}

/**
 * 合言葉をたしかめる。通れば、誰の iPhone かとカテゴリ一覧が返る。
 * @param {string} aikotoba
 * @returns {Promise<{ok: true, user: string, categories: string[]}>}
 */
export function login(aikotoba) {
  return callApi("login", {}, { aikotoba });
}

/**
 * 起動時にまとめて取る: 誰の iPhone か、カテゴリ一覧、削除されていない記録の全件。
 * @returns {Promise<{ok: true, user: string, categories: string[], records: object[]}>}
 */
export function sync() {
  return callApi("sync");
}

/**
 * 記録を1件送る。同じ id を何度送っても、保存先には1行しか書かれない。
 * @param {{id: string, 日付: string, 財布: string, 種類: string, 項目: string, メモ: string, 金額: number}} record
 * @returns {Promise<{ok: true, id: string, duplicate: boolean}>}
 */
export function addRecord(record) {
  return callApi("addRecord", {
    id: record.id,
    日付: record["日付"],
    財布: record["財布"],
    種類: record["種類"],
    項目: record["項目"],
    メモ: record["メモ"],
    金額: record["金額"],
  });
}

/**
 * 記録を1件なおす(日付・財布・種類・項目・メモ・金額)。同じ内容を何度送っても安全。
 * 保存先に無い・削除済みのときも成功が返る(found: false / deleted: true)。
 * @param {{id: string, 日付: string, 財布: string, 種類: string, 項目: string, メモ: string, 金額: number}} record
 * @returns {Promise<{ok: true, id: string, found: boolean, updated: boolean, deleted?: boolean}>}
 */
export function updateRecord(record) {
  return callApi("updateRecord", {
    id: record.id,
    日付: record["日付"],
    財布: record["財布"],
    種類: record["種類"],
    項目: record["項目"],
    メモ: record["メモ"],
    金額: record["金額"],
  });
}

/**
 * 記録を取り消す(保存先では「削除」の印が付くだけで、行は残る)。何度送っても安全。
 * @param {string} id
 * @returns {Promise<{ok: true, id: string, found: boolean}>}
 */
export function deleteRecord(id) {
  return callApi("deleteRecord", { id });
}
