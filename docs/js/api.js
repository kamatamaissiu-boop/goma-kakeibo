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
 *   busy           … 同時書き込みで順番待ちが時間切れ
 *   それ以外       … サーバー側のエラー(server / bad_request / unknown_action)
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
