/**
 * ごまちゃん家計簿 API(Google Apps Script)
 *
 * 使い方(さいしょの1回)
 *  1. 家計簿のスプレッドシートを開き、「拡張機能」→「Apps Script」を開く
 *  2. このファイルの中身をすべて貼り付けて保存する
 *  3. スプレッドシートを開き直すと、メニューに「ごまちゃん家計簿」が出る
 *  4. メニューの ①(初期設定)→ ②・③(合言葉)の順に実行する
 *  5. Apps Script の「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *     実行するユーザー: 自分 / アクセスできるユーザー: 全員
 *     出てきた URL を、アプリの docs/js/config.js の GAS_URL に入れる
 *
 * 約束ごと
 *  - このスクリプトが作る・書きかえるのは、アプリ用の5つのシートだけ
 *    (記録 / 毎月の項目 / 毎月の確定 / 写真 / 設定)。
 *    「2026年収支表」やフォームの回答シートなど、もとからあるシートには触れない。
 *  - 合言葉そのものは、どこにも保存しない・ログにも出さない。
 *    保存するのは「ソルト付き SHA-256 のハッシュ値」だけ。
 *  - 合言葉が合わない通信には、データを一切返さない。
 */

// ============================================================================
// 定数
// ============================================================================

/** アプリ用シートの名前 */
const SHEET = {
  RECORDS: '記録',
  MONTHLY_ITEMS: '毎月の項目',
  MONTHLY_CLOSED: '毎月の確定',
  PHOTOS: '写真',
  SETTINGS: '設定',
};

/** 使う人(合言葉は1人ずつ別) */
const USERS = ['ゆうき', 'まゆ'];

/** 各シートの列名(1行目) */
const HEADERS = {
  RECORDS: ['id', '作成日時', '日付', '月', '財布', '種類', '項目', 'メモ', '金額', '記録した人', '元', '削除'],
  MONTHLY_ITEMS: ['id', '持ち主', '区分', '項目名', '金額', '毎月かわる', '有効', '並び順'],
  MONTHLY_CLOSED: ['月', '確定した人', '確定日時'],
  PHOTOS: ['id', 'ドライブのファイルID', '足した人', '追加日時', '有効'],
  SETTINGS: ['キー', '値', '説明'],
};

/** `設定` シートの形: A〜C列 =「キー / 値 / 説明」、E列 = カテゴリ一覧(D列は空けておく) */
const SETTINGS_COL = { KEY: 1, VALUE: 2, NOTE: 3, CATEGORY: 5 };
const SETTINGS_CATEGORY_HEADER = 'カテゴリ';

/** `設定` シートのキー名 */
const SETTING_KEY = {
  SALT: 'ソルト',
  HASH_PREFIX: '合言葉ハッシュ_', // うしろに名前が付く(例: 合言葉ハッシュ_ゆうき)
};

/** 変動費のカテゴリ(初期値。あとは `設定` シートの E列で増減する) */
const DEFAULT_CATEGORIES = ['食費', '生活必需品', '交通費', '交際費', '娯楽費', '衣類', '美容系', '病院', 'ごまちゃん'];

/**
 * `毎月の項目` の初期データ(仕様書 4.3 の表)。金額は空で登録する。
 * [持ち主, 区分, 項目名, 毎月かわる]
 * ※ 水道代は、いったん「ゆうき」の固定費のまま(共同口座に移すかは未決定)。
 */
const DEFAULT_MONTHLY_ITEMS = [
  ['共同口座', '固定費', '住居費', false],
  ['共同口座', '固定費', '光熱費', true],
  ['ゆうき', '固定費', '水道代', false],
  ['ゆうき', '固定費', '奨学金', false],
  ['ゆうき', '固定費', 'NETFLIX', false],
  ['ゆうき', '固定費', '携帯', false],
  ['まゆ', '固定費', '携帯', false],
  ['まゆ', '固定費', 'Spotify', false],
  ['まゆ', '固定費', 'google', false],
  ['まゆ', '固定費', 'iCloud', false],
  ['まゆ', '固定費', 'まつぱ', false],
  ['まゆ', '固定費', '美容院', false],
  ['まゆ', '固定費', 'コンタクト', false],
  ['まゆ', '固定費', 'ピラティス', false],
  ['ゆうき', '貯蓄', 'NISA', false],
  ['まゆ', '貯蓄', 'NISA', false],
  ['ゆうき', '収入', '給料', false],
  ['まゆ', '収入', '給料', false],
  ['まゆ', '収入', 'バイト', false],
  ['まゆ', '収入', '英検', false],
];

/** 合言葉の最短の長さ(文字数) */
const MIN_AIKOTOBA_LENGTH = 4;

/** 同時書き込みの順番待ちの上限(ミリ秒) */
const LOCK_WAIT_MS = 20000;

/**
 * API の一覧(ハンドラの表)。
 * 段階1以降は、ここに1行足して、下に handleXxx_ を書けば action が増える。
 *   fn   … 処理の本体。引数は ctx = { user, settings, req }。返した値がそのまま応答になる
 *   lock … true なら、ほかの書き込みが終わるのを待ってから実行する(書き込む action 用)
 */
const HANDLERS = {
  login: { fn: handleLogin_, lock: false },
};

// ============================================================================
// メニュー
// ============================================================================

/** スプレッドシートを開いたときに、メニューを足す */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('ごまちゃん家計簿')
    .addItem('① 初期設定(アプリ用シートを作る)', 'setup')
    .addItem('② 合言葉を設定(ゆうき)', 'setAikotobaYuuki')
    .addItem('③ 合言葉を設定(まゆ)', 'setAikotobaMayu')
    .addToUi();
}

function setAikotobaYuuki() {
  setAikotoba_('ゆうき');
}

function setAikotobaMayu() {
  setAikotoba_('まゆ');
}

// ============================================================================
// ① 初期設定
// ============================================================================

/**
 * アプリ用のシートを、無ければ作る。あるシートには何もしない。
 * 何度実行しても安全。もとからあるシートには一切触れない。
 */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const before = ss.getActiveSheet();
  const created = [];
  const skipped = [];

  const plan = [
    [SHEET.RECORDS, initRecordsSheet_],
    [SHEET.MONTHLY_ITEMS, initMonthlyItemsSheet_],
    [SHEET.MONTHLY_CLOSED, initMonthlyClosedSheet_],
    [SHEET.PHOTOS, initPhotosSheet_],
    [SHEET.SETTINGS, initSettingsSheet_],
  ];

  withLock_(function () {
    plan.forEach(function (item) {
      const name = item[0];
      const init = item[1];
      if (ss.getSheetByName(name)) {
        skipped.push(name); // すでにある → 何もしない
        return;
      }
      // いちばん右に足す(もとからあるシートの並びを変えない)
      const sheet = ss.insertSheet(name, ss.getNumSheets());
      try {
        init(sheet);
      } catch (err) {
        // 作りかけを残すと次回「すでにある」と見なされてしまうので、いま作った分だけ消す
        ss.deleteSheet(sheet);
        throw err;
      }
      created.push(name);
    });
  });

  // 開いていたシートに戻す
  if (before) {
    ss.setActiveSheet(before);
  }

  const lines = [];
  lines.push(created.length ? '作ったシート: ' + created.join('、') : '新しく作ったシートはありません。');
  if (skipped.length) {
    lines.push('すでにあったので何もしなかったシート: ' + skipped.join('、'));
  }
  lines.push('');
  lines.push('つぎに、メニューの ②・③ で2人の合言葉を設定してください。');
  notify_(lines.join('\n'));
}

/** 1行目に列名を書き、太字にして固定する */
function writeHeader_(sheet, headers) {
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sheet.setFrozenRows(1);
}

/** 指定した列を「書式なしテキスト」にする(2026-11 や 1/2 が勝手に日付へ変わるのを防ぐ) */
function setTextColumns_(sheet, columns) {
  const rows = sheet.getMaxRows();
  columns.forEach(function (col) {
    sheet.getRange(1, col, rows, 1).setNumberFormat('@');
  });
}

function initRecordsSheet_(sheet) {
  writeHeader_(sheet, HEADERS.RECORDS);
  // id / 月 / 項目 / メモ は文字のまま持つ
  setTextColumns_(sheet, [1, 4, 7, 8]);
}

function initMonthlyItemsSheet_(sheet) {
  writeHeader_(sheet, HEADERS.MONTHLY_ITEMS);
  setTextColumns_(sheet, [1, 4]); // id / 項目名

  const rows = DEFAULT_MONTHLY_ITEMS.map(function (item, i) {
    const no = i + 1;
    const id = 'M' + ('00' + no).slice(-3);
    // id, 持ち主, 区分, 項目名, 金額(空), 毎月かわる, 有効, 並び順
    return [id, item[0], item[1], item[2], '', item[3], true, no * 10];
  });
  sheet.getRange(2, 1, rows.length, HEADERS.MONTHLY_ITEMS.length).setValues(rows);
  // 「毎月かわる」「有効」はチェックボックスにする(人が見て分かるように)
  sheet.getRange(2, 6, rows.length, 2).insertCheckboxes();
}

function initMonthlyClosedSheet_(sheet) {
  writeHeader_(sheet, HEADERS.MONTHLY_CLOSED);
  setTextColumns_(sheet, [1]); // 月(YYYY-MM)
}

function initPhotosSheet_(sheet) {
  writeHeader_(sheet, HEADERS.PHOTOS);
  setTextColumns_(sheet, [1, 2]); // id / ドライブのファイルID
}

function initSettingsSheet_(sheet) {
  // すべて文字として持つ(ハッシュ値が数値と解釈されるのを防ぐ)
  setTextColumns_(sheet, [SETTINGS_COL.KEY, SETTINGS_COL.VALUE, SETTINGS_COL.NOTE, SETTINGS_COL.CATEGORY]);

  // 左のブロック: キー / 値 / 説明
  writeHeader_(sheet, HEADERS.SETTINGS);
  const rows = [
    [SETTING_KEY.SALT, generateSalt_(), '合言葉を照合するためのランダムな文字列です。書きかえないでください(書きかえた場合は、合言葉を2人とも設定し直します)'],
  ];
  USERS.forEach(function (user, i) {
    rows.push([
      SETTING_KEY.HASH_PREFIX + user,
      '',
      'メニューの「合言葉を設定(' + user + ')」で入ります。合言葉そのものではありません(ハッシュ値)',
    ]);
  });
  sheet.getRange(2, 1, rows.length, 3).setValues(rows);

  // 右のブロック: カテゴリ一覧(E列)
  sheet
    .getRange(1, SETTINGS_COL.CATEGORY)
    .setValue(SETTINGS_CATEGORY_HEADER)
    .setFontWeight('bold')
    .setNote('変動費のカテゴリです。上から順にアプリに並びます。この列に行を足したり消したりすると、アプリのボタンが増減します。');
  const categories = DEFAULT_CATEGORIES.map(function (name) {
    return [name];
  });
  sheet.getRange(2, SETTINGS_COL.CATEGORY, categories.length, 1).setValues(categories);

  sheet.setColumnWidth(SETTINGS_COL.KEY, 170);
  sheet.setColumnWidth(SETTINGS_COL.VALUE, 260);
  sheet.setColumnWidth(SETTINGS_COL.NOTE, 520);
  sheet.setColumnWidth(SETTINGS_COL.CATEGORY, 140);
}

// ============================================================================
// ②③ 合言葉の設定
// ============================================================================

/** 合言葉を入力してもらい、ハッシュ値だけを `設定` シートに保存する */
function setAikotoba_(user) {
  const ui = SpreadsheetApp.getUi();
  const other = USERS.filter(function (name) {
    return name !== user;
  })[0];

  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET.SETTINGS)) {
    ui.alert('さきに、メニューの「① 初期設定」を実行してください。');
    return;
  }

  const answer = ui.prompt(
    '合言葉を設定(' + user + ')',
    user + ' の合言葉を入れてください(' + MIN_AIKOTOBA_LENGTH + '文字以上)。\n' +
      'アプリを最初に開いたときに1回だけ入力するものです。' + other + ' とは別の合言葉にしてください。',
    ui.ButtonSet.OK_CANCEL
  );
  if (answer.getSelectedButton() !== ui.Button.OK) {
    return;
  }

  const aikotoba = normalizeAikotoba_(answer.getResponseText());
  if (countChars_(aikotoba) < MIN_AIKOTOBA_LENGTH) {
    ui.alert('合言葉が短すぎます。' + MIN_AIKOTOBA_LENGTH + '文字以上にしてください。\n(設定は変わっていません)');
    return;
  }

  // 結果の文言(合言葉そのものは含めない)
  const message = withLock_(function () {
    const settings = readSettings_();
    if (!settings) {
      return 'さきに、メニューの「① 初期設定」を実行してください。';
    }

    let salt = settings.map[SETTING_KEY.SALT];
    let saltRenewed = false;
    if (!salt) {
      // ソルトが消されていた場合は作り直す。古いハッシュ値は使えなくなるので消す
      salt = generateSalt_();
      writeSetting_(settings, SETTING_KEY.SALT, salt);
      USERS.forEach(function (name) {
        writeSetting_(settings, SETTING_KEY.HASH_PREFIX + name, '');
        settings.map[SETTING_KEY.HASH_PREFIX + name] = '';
      });
      saltRenewed = true;
    }

    const hash = hashAikotoba_(salt, aikotoba);
    if (settings.map[SETTING_KEY.HASH_PREFIX + other] === hash) {
      return other + ' と同じ合言葉は使えません。別の合言葉にしてください。\n(設定は変わっていません)';
    }

    writeSetting_(settings, SETTING_KEY.HASH_PREFIX + user, hash);
    let text = user + ' の合言葉を設定しました。\n' + user + ' の iPhone でアプリを開き、この合言葉を入れてください。';
    if (saltRenewed) {
      text += '\n\n※ ソルトが空だったので作り直しました。' + other + ' の合言葉も設定し直してください。';
    }
    return text;
  });

  ui.alert(message);
}

/** 合言葉の前後の空白を取り、全角・半角などの表記ゆれをそろえる */
function normalizeAikotoba_(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).normalize('NFKC').trim();
}

/** 文字数を数える(絵文字なども1文字として数える) */
function countChars_(text) {
  return Array.from(text).length;
}

/** ソルト(ランダムな文字列)を作る */
function generateSalt_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

/** ソルト付き SHA-256 のハッシュ値(16進64文字)を返す */
function hashAikotoba_(salt, aikotoba) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    salt + ':' + aikotoba,
    Utilities.Charset.UTF_8
  );
  return bytesToHex_(bytes);
}

/**
 * バイト列を16進文字列にする。
 * GAS のバイトは符号付き(-128〜127)なので、0〜255 に直してから2桁にそろえる。
 */
function bytesToHex_(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] & 0xff;
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

// ============================================================================
// `設定` シートの読み書き
// ============================================================================

/**
 * `設定` シートを読む。シートが無ければ null。
 * @return {{sheet: Sheet, map: Object, rowOf: Object, categories: string[]}|null}
 */
function readSettings_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET.SETTINGS);
  if (!sheet) {
    return null;
  }
  const values = sheet.getDataRange().getValues();
  const map = {};
  const rowOf = {};
  const categories = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const key = String(row[SETTINGS_COL.KEY - 1]).trim();
    if (key && !(key in rowOf)) {
      map[key] = String(row[SETTINGS_COL.VALUE - 1]).trim();
      rowOf[key] = r + 1;
    }
    const category = row.length >= SETTINGS_COL.CATEGORY ? String(row[SETTINGS_COL.CATEGORY - 1]).trim() : '';
    if (category && categories.indexOf(category) === -1) {
      categories.push(category);
    }
  }
  return { sheet: sheet, map: map, rowOf: rowOf, categories: categories };
}

/** `設定` シートの値を1つ書く(キーの行が無ければ、いちばん下に足す) */
function writeSetting_(settings, key, value) {
  const sheet = settings.sheet;
  let row = settings.rowOf[key];
  if (!row) {
    row = sheet.getLastRow() + 1;
    sheet.getRange(row, SETTINGS_COL.KEY).setNumberFormat('@').setValue(key);
    settings.rowOf[key] = row;
  }
  sheet.getRange(row, SETTINGS_COL.VALUE).setNumberFormat('@').setValue(value);
  settings.map[key] = value;
}

// ============================================================================
// Web アプリ(API)
// ============================================================================

/** ブラウザで URL を開いたとき用。動いていることだけ伝える(データは返さない) */
function doGet() {
  return ContentService.createTextOutput('ごまちゃん家計簿 API は動いています').setMimeType(ContentService.MimeType.TEXT);
}

/**
 * アプリからの通信の入口。
 * 本文は JSON 文字列(Content-Type は text/plain)。
 *   { "action": "login", "合言葉": "…", … }   ※ "合言葉" の代わりに "token" でも可
 * 応答は JSON。
 *   成功: { "ok": true, … }
 *   失敗: { "ok": false, "error": "auth" | "setup" | "bad_request" | "unknown_action" | "busy" | "server" }
 */
function doPost(e) {
  let result;
  try {
    result = handleRequest_(e);
  } catch (err) {
    if (err && err.name === 'BusyError') {
      result = { ok: false, error: 'busy' };
    } else {
      // 合言葉や本文はログに出さない(エラーの文言だけ)
      console.error('doPost でエラー: ' + (err && err.message ? err.message : err));
      result = { ok: false, error: 'server' };
    }
  }
  return json_(result);
}

function handleRequest_(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return { ok: false, error: 'bad_request' };
  }
  if (!req || typeof req !== 'object' || Array.isArray(req)) {
    return { ok: false, error: 'bad_request' };
  }

  // まず合言葉。合わなければ、ここで終わり(action の有無なども教えない)
  const given = req['合言葉'] !== undefined && req['合言葉'] !== null ? req['合言葉'] : req.token;
  const auth = authenticate_(given);
  if (!auth.user) {
    return { ok: false, error: auth.error };
  }

  const action = typeof req.action === 'string' ? req.action : '';
  const handler = Object.prototype.hasOwnProperty.call(HANDLERS, action) ? HANDLERS[action] : null;
  if (!handler) {
    return { ok: false, error: 'unknown_action' };
  }

  const ctx = { user: auth.user, settings: auth.settings, req: req };
  if (handler.lock) {
    return withLock_(function () {
      return handler.fn(ctx);
    });
  }
  return handler.fn(ctx);
}

/**
 * 合言葉から、誰の iPhone かを決める。
 * @return {{user: string, settings: Object}|{user: null, error: string}}
 *   error … 'auth'(合言葉がちがう) / 'setup'(初期設定か合言葉の設定がまだ)
 */
function authenticate_(given) {
  const settings = readSettings_();
  if (!settings) {
    return { user: null, error: 'setup' };
  }
  const salt = settings.map[SETTING_KEY.SALT];
  const hashes = USERS.map(function (user) {
    return settings.map[SETTING_KEY.HASH_PREFIX + user] || '';
  });
  const anySet = hashes.some(function (hash) {
    return hash !== '';
  });
  if (!salt || !anySet) {
    return { user: null, error: 'setup' };
  }

  if (typeof given !== 'string') {
    return { user: null, error: 'auth' };
  }
  const aikotoba = normalizeAikotoba_(given);
  if (!aikotoba) {
    return { user: null, error: 'auth' };
  }

  const hash = hashAikotoba_(salt, aikotoba);
  for (let i = 0; i < USERS.length; i++) {
    if (hashes[i] !== '' && hashes[i] === hash) {
      return { user: USERS[i], settings: settings };
    }
  }
  return { user: null, error: 'auth' };
}

/** JSON の応答を作る */
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ============================================================================
// action ごとの処理
// ============================================================================

/** login: 合言葉が通ったことと、誰の iPhone か、カテゴリ一覧を返す */
function handleLogin_(ctx) {
  return { ok: true, user: ctx.user, categories: ctx.settings.categories };
}

// ============================================================================
// 共通の道具
// ============================================================================

/**
 * 同時書き込みを防ぐ共通ラッパ。
 * ほかの実行が終わるのを最大 LOCK_WAIT_MS 待ち、fn を実行し、終わったら必ず鍵を返す。
 * 待ち切れなかったときは BusyError を投げる(API では { ok:false, error:"busy" } になる)。
 */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    const err = new Error('ほかの処理が終わるのを待ち切れませんでした。少し待ってやり直してください。');
    err.name = 'BusyError';
    throw err;
  }
  try {
    const result = fn();
    SpreadsheetApp.flush(); // 鍵を返す前に、書き込みを確定させる
    return result;
  } finally {
    lock.releaseLock();
  }
}

/** 画面にお知らせを出す(画面が無い実行のときは、ログに出す) */
function notify_(message) {
  try {
    SpreadsheetApp.getUi().alert(message);
  } catch (err) {
    console.log(message);
  }
}
