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
 *
 * コードを直したとき(2回目以降)
 *  - このファイルの中身をすべて貼り直して保存し、
 *    「デプロイ」→「デプロイを管理」→ 鉛筆(編集)→ バージョン「新バージョン」→「デプロイ」。
 *    (URL は変わらない。「新しいデプロイ」を選ぶと URL が変わってしまうので注意)
 *  - メニュー①(初期設定)をやり直す必要はない。シートは作り直さない。
 *
 * 過去データ(Google フォームの回答)の取り込み
 *  - メニューの「④ フォームの回答を取り込む」を押す。回答シートは読むだけで、書きかえない。
 *  - 何度押しても二重にならない。アプリで消した記録が、押し直して復活することもない。
 *  - 「⑤ 月ごとの集計を見る(確認用)」で、月×財布×種類ごとの件数と合計を、いつでも見直せる。
 *
 * 毎月の設定(固定費・貯蓄・収入・税金)
 *  - ひな形は `毎月の項目` シート。アプリの「毎月の設定」で月を確定すると、
 *    その月の分が `記録` に「元 = 自動」で入る(id は「auto-年月-項目id」。確定し直すと同じ行を書きかえる)。
 *  - 税金・社会保険の5項目(2人分)は、アプリが最初に読みに来たときに、無ければ自動で足す(1回だけ)。
 *  - 持ち主は、シートのいまの値で決める(B列を手で書きかえれば、次の確定からその財布の記録になる)。
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
  MONTHLY_READY: '毎月の項目の準備', // 税金の項目を足すなどの準備が済んだら「済み」が入る
};
const MONTHLY_READY_VALUE = '済み';

/** 変動費のカテゴリ(初期値。あとは `設定` シートの E列で増減する) */
const DEFAULT_CATEGORIES = ['食費', '生活必需品', '交際費', '交通費', '病院', '衣類', '雑貨', '美容系', '娯楽費', 'ごまちゃん'];

/**
 * `毎月の項目` の初期データ(仕様書 4.3 の表)。金額は空で登録する。
 * [持ち主, 区分, 項目名, 毎月かわる]
 * ※ 水道代は「共同口座」の固定費(2026-11 に決定)。
 *   すでにあるシートは作り直さないので、稼働中のシートは B列(持ち主)を手で書きかえる。
 */
const DEFAULT_MONTHLY_ITEMS = [
  ['共同口座', '固定費', '住居費', false],
  ['共同口座', '固定費', '光熱費', true],
  ['共同口座', '固定費', '水道代', false],
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

/** 毎月の設定で確定する種類(`毎月の項目` の「区分」と同じ文字)。`記録` の「種類」にも、この文字が入る */
const MONTHLY = { FIXED: '固定費', SAVING: '貯蓄', INCOME: '収入', TAX: '税金' };
const MONTHLY_KINDS = [MONTHLY.FIXED, MONTHLY.SAVING, MONTHLY.INCOME, MONTHLY.TAX];

/** 税金・社会保険の項目(2人それぞれに、無ければ足す。任意入力) */
const DEFAULT_TAX_ITEMS = ['所得税', '住民税', '健康保険', '厚生年金', '雇用保険料'];

/** `毎月の項目` の項目名の長さの上限(文字数)と、1回の確定で受けつける項目数の上限 */
const MAX_ITEM_NAME_LENGTH = 30;
const MAX_CLOSE_ITEMS = 300;

/** 合言葉の最短の長さ(文字数) */
const MIN_AIKOTOBA_LENGTH = 4;

/** 同時書き込みの順番待ちの上限(ミリ秒) */
const LOCK_WAIT_MS = 20000;

/** 日時を文字にするときのタイムゾーン(日本時間で固定) */
const TZ = 'Asia/Tokyo';

/** 共同口座の財布の名前 */
const WALLET_JOINT = '共同口座';

/** アプリの入力画面から記録できる種類 */
const KIND = { VARIABLE: '変動費', SPECIAL: '特別費', DEPOSIT: '共同へ入金' };
const APP_KINDS = [KIND.VARIABLE, KIND.SPECIAL, KIND.DEPOSIT];

/** `記録` の「元」列に入れる値(アプリからの記録) */
const SOURCE_APP = 'アプリ';

/** `記録` の「元」列に入れる値(フォームの回答から取り込んだ記録)と、その id の頭 */
const SOURCE_FORM = 'フォーム取り込み';
const FORM_ID_PREFIX = 'form-';

/** `記録` の「元」列に入れる値(毎月の設定で確定した記録)と、その id の頭(auto-年月-項目id) */
const SOURCE_AUTO = '自動';
const AUTO_ID_PREFIX = 'auto-';

/** フォームの回答の「種類」として取り込むもの */
const FORM_KINDS = [KIND.VARIABLE, KIND.SPECIAL];

/** 取り込みで、カテゴリ・内容が空だった行に入れておく文字 */
const FORM_EMPTY_ITEM = '未分類';
const FORM_EMPTY_MEMO = '(内容なし)';

/** お知らせのダイアログに、1種類につき何行まで出すか(それ以上は「ほか◯件」) */
const REPORT_MAX_LINES = 30;

/** `記録` の「削除」列に付ける印(行は消さない) */
const DELETED_MARK = '削除';

/** 金額の上限(円)と、項目・メモの長さの上限(文字数) */
const MAX_AMOUNT = 99999999;
const MAX_TEXT_LENGTH = 100;

/**
 * 総当たり対策: 合言葉の照合に失敗した回数を数える。
 * WINDOW_SEC 秒のあいだに MAX 回失敗したら、その間は照合せずに locked を返す。
 * (GAS では相手の IP が分からないので、全体で1つのカウンタ)
 */
const AUTH_FAIL = { CACHE_KEY: 'auth_fail_v1', WINDOW_SEC: 600, MAX: 30 };

/**
 * API の一覧(ハンドラの表)。
 * ここに1行足して、下に handleXxx_ を書けば action が増える。
 *   fn   … 処理の本体。引数は ctx = { user, settings, req }。返した値がそのまま応答になる
 *   lock … true なら、ほかの書き込みが終わるのを待ってから実行する(書き込む action 用)
 */
const HANDLERS = {
  login: { fn: handleLogin_, lock: false },
  sync: { fn: handleSync_, lock: false },
  addRecord: { fn: handleAddRecord_, lock: true },
  updateRecord: { fn: handleUpdateRecord_, lock: true },
  deleteRecord: { fn: handleDeleteRecord_, lock: true },
  addMonthlyItem: { fn: handleAddMonthlyItem_, lock: true },
  updateMonthlyItem: { fn: handleUpdateMonthlyItem_, lock: true },
  closeMonth: { fn: handleCloseMonth_, lock: true },
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
    .addSeparator()
    .addItem('④ フォームの回答を取り込む', 'importFormResponses')
    .addItem('⑤ 月ごとの集計を見る(確認用)', 'showMonthlySummary')
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
  // 「毎月かわる」「有効」はチェックボックスにする(人が見て分かるように)。
  // insertCheckboxes は、その範囲の値をすべて FALSE にするので、値を書く前に行う
  sheet.getRange(2, 6, rows.length, 2).insertCheckboxes();
  sheet.getRange(2, 1, rows.length, HEADERS.MONTHLY_ITEMS.length).setValues(rows);
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

/** `設定` シートの値を1つ書く(キーの行が無ければ、いちばん下に足す。note はそのときの説明) */
function writeSetting_(settings, key, value, note) {
  const sheet = settings.sheet;
  let row = settings.rowOf[key];
  if (!row) {
    row = sheet.getLastRow() + 1;
    sheet.getRange(row, SETTINGS_COL.KEY).setNumberFormat('@').setValue(key);
    if (note) {
      sheet.getRange(row, SETTINGS_COL.NOTE).setNumberFormat('@').setValue(note);
    }
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
 *   失敗: { "ok": false, "error": "auth" | "locked" | "setup" | "bad_request" | "unknown_action"
 *                                  | "invalid" | "forbidden" | "busy" | "server" }
 * action: login / sync / addRecord / updateRecord / deleteRecord
 *         / addMonthlyItem / updateMonthlyItem / closeMonth(毎月の設定)
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

  // 合言葉の間違いが続いているあいだは、照合そのものをしない(総当たり対策)
  if (isAuthLocked_()) {
    return { ok: false, error: 'locked' };
  }

  // まず合言葉。合わなければ、ここで終わり(action の有無なども教えない)
  const given = req['合言葉'] !== undefined && req['合言葉'] !== null ? req['合言葉'] : req.token;
  const auth = authenticate_(given);
  if (!auth.user) {
    if (auth.error === 'auth') {
      recordAuthFailure_();
    }
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

/**
 * いまの失敗回数を読む。数えはじめから WINDOW_SEC 秒を過ぎていれば null。
 * キャッシュが使えないときは null(= 制限なし)にして、ふつうの利用を止めない。
 * @return {{count: number, start: number}|null}
 */
function readAuthFailures_() {
  try {
    const raw = CacheService.getScriptCache().get(AUTH_FAIL.CACHE_KEY);
    if (!raw) {
      return null;
    }
    const state = JSON.parse(raw);
    if (!state || typeof state.count !== 'number' || typeof state.start !== 'number') {
      return null;
    }
    if (Date.now() - state.start >= AUTH_FAIL.WINDOW_SEC * 1000) {
      return null;
    }
    return state;
  } catch (err) {
    return null;
  }
}

/** 合言葉の間違いが続いて、いまは受け付けを止めているか */
function isAuthLocked_() {
  const state = readAuthFailures_();
  return Boolean(state) && state.count >= AUTH_FAIL.MAX;
}

/** 合言葉の間違いを1回数える(最初の間違いから WINDOW_SEC 秒で自動的に消える) */
function recordAuthFailure_() {
  try {
    const now = Date.now();
    const state = readAuthFailures_() || { count: 0, start: now };
    state.count += 1;
    const remainSec = Math.max(1, Math.ceil((state.start + AUTH_FAIL.WINDOW_SEC * 1000 - now) / 1000));
    CacheService.getScriptCache().put(AUTH_FAIL.CACHE_KEY, JSON.stringify(state), remainSec);
  } catch (err) {
    console.error('失敗回数を記録できませんでした: ' + (err && err.message ? err.message : err));
  }
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

/**
 * sync: 起動時にまとめて取る。誰の iPhone か、カテゴリ一覧、削除されていない記録の全件、
 * 毎月の項目(monthlyItems)と、月の確定の一覧(monthlyClosed)。
 * 相手の財布の分も返す(絞り込みは画面側。仕様書 3章)。
 */
function handleSync_(ctx) {
  // 税金の項目などの準備(1回だけ)。うまくいかなくても、同期そのものは止めない
  try {
    ensureMonthlyItems_(ctx.settings);
  } catch (err) {
    console.error('毎月の項目の準備ができませんでした: ' + (err && err.message ? err.message : err));
  }
  return syncPayload_(ctx);
}

/** sync と同じ中身を作る(毎月の設定の action も、書いたあとにこれを返す。画面は1回の通信で最新になる) */
function syncPayload_(ctx) {
  const table = openRecords_();
  if (!table) {
    return { ok: false, error: 'setup' };
  }
  const itemsTable = openMonthlyItems_();
  const closedTable = openMonthlyClosed_();
  return {
    ok: true,
    user: ctx.user,
    categories: ctx.settings.categories,
    records: listRecords_(table),
    monthlyItems: itemsTable ? readMonthlyItems_(itemsTable).map(publicMonthlyItem_) : [],
    monthlyClosed: closedTable ? listMonthlyClosed_(closedTable) : [],
  };
}

/**
 * addRecord: 記録を1件足す。
 *   リクエスト: { id, 日付, 財布, 種類, 項目, メモ, 金額 }
 *   同じ id がすでにあれば、書かずに成功を返す(送り直しで二重にならない)。
 */
function handleAddRecord_(ctx) {
  const checked = validateRecord_(ctx.req, ctx.user);
  if (checked.field) {
    return { ok: false, error: 'invalid', field: checked.field };
  }
  const record = checked.record;

  const table = openRecords_();
  if (!table) {
    return { ok: false, error: 'setup' };
  }
  if (findRecordRow_(table, record.id) > 0) {
    return { ok: true, id: record.id, duplicate: true };
  }

  const now = new Date();
  appendRecord_(table, {
    'id': record.id,
    '作成日時': Utilities.formatDate(now, TZ, 'yyyy-MM-dd HH:mm:ss'),
    '日付': record.date,
    '月': record.date.slice(0, 7),
    '財布': record.wallet,
    '種類': record.kind,
    '項目': record.item,
    'メモ': record.memo,
    '金額': record.amount,
    '記録した人': ctx.user,
    '元': SOURCE_APP,
    '削除': '',
  });
  return { ok: true, id: record.id, duplicate: false };
}

/**
 * deleteRecord: 記録を取り消す(「削除」列に印を付ける。行は消さない)。
 *   リクエスト: { id }
 *   消せるのは、自分の財布か共同口座の記録、または自分が記録したもの(canModify_)。
 *   見つからない・すでに削除済みでも成功を返す(送り直しても安全)。
 */
function handleDeleteRecord_(ctx) {
  const id = ctx.req.id;
  if (!isValidId_(id)) {
    return { ok: false, error: 'invalid', field: 'id' };
  }
  const table = openRecords_();
  if (!table) {
    return { ok: false, error: 'setup' };
  }
  const rowNo = findRecordRow_(table, id);
  if (rowNo < 0) {
    return { ok: true, id: id, found: false };
  }
  const row = table.values[rowNo - 1];
  if (isDeleted_(row[table.col['削除']])) {
    return { ok: true, id: id, found: true };
  }
  if (isAutoRecord_(table, row)) {
    return { ok: false, error: 'forbidden' }; // 固定費などは「毎月の設定」の確定でだけ変える
  }
  if (!canModify_(table, row, ctx.user)) {
    return { ok: false, error: 'forbidden' };
  }
  table.sheet.getRange(rowNo, table.col['削除'] + 1).setNumberFormat('@').setValue(DELETED_MARK);
  return { ok: true, id: id, found: true };
}

/**
 * updateRecord: 記録を1件なおす(日付・月・財布・種類・項目・メモ・金額 を書きかえる)。
 *   リクエスト: { id, 日付, 財布, 種類, 項目, メモ, 金額 }(中身の決まりは addRecord と同じ)
 *   なおせるのは、自分の財布か共同口座の記録、または自分が記録したもの(canModify_)。
 *   作成日時・記録した人・元 は変えない。
 *   同じ内容を何度送っても結果は同じ。見つからない・削除済みのときは、書かずに成功を返す。
 */
function handleUpdateRecord_(ctx) {
  const checked = validateRecord_(ctx.req, ctx.user);
  if (checked.field) {
    return { ok: false, error: 'invalid', field: checked.field };
  }
  const record = checked.record;

  const table = openRecords_();
  if (!table) {
    return { ok: false, error: 'setup' };
  }
  const rowNo = findRecordRow_(table, record.id);
  if (rowNo < 0) {
    return { ok: true, id: record.id, found: false, updated: false };
  }
  const row = table.values[rowNo - 1];
  if (isDeleted_(row[table.col['削除']])) {
    return { ok: true, id: record.id, found: true, deleted: true, updated: false };
  }
  if (isAutoRecord_(table, row)) {
    return { ok: false, error: 'forbidden' }; // 固定費などは「毎月の設定」の確定でだけ変える
  }
  if (!canModify_(table, row, ctx.user)) {
    return { ok: false, error: 'forbidden' };
  }

  const next = {
    '日付': record.date,
    '月': record.date.slice(0, 7),
    '財布': record.wallet,
    '種類': record.kind,
    '項目': record.item,
    'メモ': record.memo,
    '金額': record.amount,
  };
  // 列は名前で探してあるので、1マスずつ書く(あいだに人が足した列があっても壊さない)
  let updated = false;
  Object.keys(next).forEach(function (name) {
    const c = table.col[name];
    const isAmount = name === '金額';
    const same = isAmount ? row[c] === next[name] : typeof row[c] === 'string' && row[c] === next[name];
    if (same) {
      return;
    }
    table.sheet
      .getRange(rowNo, c + 1)
      .setNumberFormat(isAmount ? '#,##0' : '@')
      .setValue(next[name]);
    updated = true;
  });
  return { ok: true, id: record.id, found: true, updated: updated };
}

/**
 * 毎月の設定で確定した記録(固定費・貯蓄・収入・税金)か。
 * これらは updateRecord / deleteRecord では変えられない(確定の内容とずれるため)。
 */
function isAutoRecord_(table, row) {
  return (
    String(row[table.col['元']]).trim() === SOURCE_AUTO ||
    MONTHLY_KINDS.indexOf(String(row[table.col['種類']]).trim()) !== -1 ||
    String(row[table.col['id']]).trim().indexOf(AUTO_ID_PREFIX) === 0
  );
}

/**
 * その記録を、この人がなおしたり消したりしてよいか(アプリで入力した3種類の記録について)。
 *   - 財布が本人か共同口座の記録(フォームから取り込んだ共同口座の分は、記録した人が空なので)
 *   - または、記録した人が本人
 * 相手の財布の記録は、さわれない。
 */
function canModify_(table, row, user) {
  const wallet = String(row[table.col['財布']]).trim();
  const by = String(row[table.col['記録した人']]).trim();
  return wallet === user || wallet === WALLET_JOINT || by === user;
}

// ============================================================================
// 毎月の設定(`毎月の項目` と、月の確定)
// ============================================================================

/**
 * シートを、列の名前で読む。シートが無い・列名が足りないときは null。
 * @return {{sheet: Sheet, values: Array[], col: Object}|null} col は「列名 → 0始まりの位置」
 */
function openTable_(sheetName, headers) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) {
    return null;
  }
  const values = sheet.getDataRange().getValues();
  const header = (values[0] || []).map(function (name) {
    return String(name).trim();
  });
  const col = {};
  for (let i = 0; i < headers.length; i++) {
    const index = header.indexOf(headers[i]);
    if (index === -1) {
      return null;
    }
    col[headers[i]] = index;
  }
  return { sheet: sheet, values: values, col: col };
}

function openMonthlyItems_() {
  return openTable_(SHEET.MONTHLY_ITEMS, HEADERS.MONTHLY_ITEMS);
}

function openMonthlyClosed_() {
  return openTable_(SHEET.MONTHLY_CLOSED, HEADERS.MONTHLY_CLOSED);
}

/** チェックボックスのセル(TRUE / FALSE)を読む */
function toBool_(value) {
  return value === true || String(value).trim().toUpperCase() === 'TRUE';
}

/**
 * `毎月の項目` を読む(id が空の行は飛ばす)。持ち主などは、シートのいまの値。
 * @return {Object[]} { id, owner, kind, name, amount(未登録は 0), varies, active, order, rowNo }
 */
function readMonthlyItems_(table) {
  const col = table.col;
  const list = [];
  for (let r = 1; r < table.values.length; r++) {
    const row = table.values[r];
    const id = String(row[col['id']]).trim();
    if (!id) {
      continue;
    }
    const amount = toAmount_(row[col['金額']]);
    const order = Number(row[col['並び順']]);
    list.push({
      id: id,
      owner: String(row[col['持ち主']]).trim(),
      kind: String(row[col['区分']]).trim(),
      name: String(row[col['項目名']]).trim(),
      amount: amount > 0 ? amount : 0,
      varies: toBool_(row[col['毎月かわる']]),
      active: toBool_(row[col['有効']]),
      order: isFinite(order) ? order : 0,
      rowNo: r + 1,
    });
  }
  return list;
}

/** アプリに返す形(列名と同じ日本語のキー。金額が未登録なら null) */
function publicMonthlyItem_(item) {
  return {
    'id': item.id,
    '持ち主': item.owner,
    '区分': item.kind,
    '項目名': item.name,
    '金額': item.amount > 0 ? item.amount : null,
    '毎月かわる': item.varies,
    '有効': item.active,
    '並び順': item.order,
  };
}

/** `毎月の確定` の一覧(どの月を、だれが、いつ確定したか) */
function listMonthlyClosed_(table) {
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || TZ;
  const col = table.col;
  const list = [];
  for (let r = 1; r < table.values.length; r++) {
    const row = table.values[r];
    const month = toMonthString_(row[col['月']], '', tz);
    const by = String(row[col['確定した人']]).trim();
    if (!month || !by) {
      continue;
    }
    list.push({ '月': month, '確定した人': by, '確定日時': toDateTimeString_(row[col['確定日時']], tz) });
  }
  return list;
}

/** 'YYYY-MM' か(2000〜2100年) */
function isValidMonthString_(text) {
  if (typeof text !== 'string') {
    return false;
  }
  const m = text.match(/^(\d{4})-(\d{2})$/);
  if (!m) {
    return false;
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12;
}

/**
 * 1つの列の、とびとびの行に値を書く。となり合った行は、まとめて1回で書く。
 * @param {number} colNo 列番号(1始まり)
 * @param {Object[]} cells { rowNo, value }
 * @param {string|null} format 書式(null なら変えない)
 */
function writeColumnRuns_(sheet, colNo, cells, format) {
  const sorted = cells.slice().sort(function (a, b) {
    return a.rowNo - b.rowNo;
  });
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].rowNo === sorted[j].rowNo + 1) {
      j++;
    }
    const range = sheet.getRange(sorted[i].rowNo, colNo, j - i + 1, 1);
    if (format) {
      range.setNumberFormat(format);
    }
    range.setValues(
      sorted.slice(i, j + 1).map(function (cell) {
        return [cell.value];
      })
    );
    i = j + 1;
  }
}

/**
 * `毎月の項目` の、いちばん下に項目を足す。
 * id は「M + 連番」。いまある id のいちばん大きい番号の次から振るので、重ならない。
 * @param {Object[]} items    いまある項目(readMonthlyItems_ の結果)
 * @param {Object[]} newItems { owner, kind, name, amount, varies }
 * @return {string[]} 足した項目の id
 */
function appendMonthlyItems_(table, items, newItems) {
  if (!newItems.length) {
    return [];
  }
  const sheet = table.sheet;
  const col = table.col;
  let maxNo = 0;
  let maxOrder = 0;
  items.forEach(function (item) {
    const m = /^M(\d+)$/.exec(item.id);
    if (m) {
      maxNo = Math.max(maxNo, Number(m[1]));
    }
    maxOrder = Math.max(maxOrder, item.order);
  });

  const indexes = HEADERS.MONTHLY_ITEMS.map(function (name) {
    return col[name];
  });
  const first = Math.min.apply(null, indexes);
  const width = Math.max.apply(null, indexes) - first + 1;
  const ids = [];
  const values = newItems.map(function (item) {
    maxNo += 1;
    maxOrder += 10;
    const id = 'M' + (maxNo < 1000 ? ('00' + maxNo).slice(-3) : String(maxNo));
    ids.push(id);
    const row = [];
    for (let i = 0; i < width; i++) {
      row.push('');
    }
    row[col['id'] - first] = id;
    row[col['持ち主'] - first] = item.owner;
    row[col['区分'] - first] = item.kind;
    row[col['項目名'] - first] = item.name;
    row[col['金額'] - first] = item.amount > 0 ? item.amount : '';
    row[col['毎月かわる'] - first] = Boolean(item.varies);
    row[col['有効'] - first] = true;
    row[col['並び順'] - first] = maxOrder;
    return row;
  });

  const n = values.length;
  const rowNo = Math.max(sheet.getLastRow(), 1) + 1;
  const lastRowNo = rowNo + n - 1;
  if (lastRowNo > sheet.getMaxRows()) {
    sheet.insertRowsAfter(sheet.getMaxRows(), lastRowNo - sheet.getMaxRows() + 50);
  }
  // チェックボックスは、値を書く前に入れる(insertCheckboxes は、その範囲の値を FALSE にするため)
  sheet.getRange(rowNo, col['毎月かわる'] + 1, n, 1).insertCheckboxes();
  sheet.getRange(rowNo, col['有効'] + 1, n, 1).insertCheckboxes();
  // id と項目名は文字のまま持つ
  sheet.getRange(rowNo, col['id'] + 1, n, 1).setNumberFormat('@');
  sheet.getRange(rowNo, col['項目名'] + 1, n, 1).setNumberFormat('@');
  sheet.getRange(rowNo, first + 1, n, width).setValues(values);
  return ids;
}

/**
 * `毎月の項目` の準備(1回だけ。済んだら `設定` シートに印を書く)。
 *   1. 税金・社会保険の5項目を、2人それぞれに、無ければ足す。
 *   2. 「有効」がすべて FALSE になっていたら、すべて TRUE に戻す。
 *      (以前の初期設定は、値を書いたあとにチェックボックスを入れていた。その操作は値を FALSE にするため、
 *       全項目が「停止中」に見えてしまう。アプリから停止できるようになる前なので、全部 FALSE は初期設定のせいと見なす)
 * 何度呼んでも、二重には足さない。
 */
function ensureMonthlyItems_(settings) {
  if (settings.map[SETTING_KEY.MONTHLY_READY] === MONTHLY_READY_VALUE) {
    return;
  }
  withLock_(function () {
    // 鍵を取ってから読み直す(2人が同時に開いても、二重に足さない)
    const fresh = readSettings_();
    if (!fresh || fresh.map[SETTING_KEY.MONTHLY_READY] === MONTHLY_READY_VALUE) {
      return;
    }
    const table = openMonthlyItems_();
    if (!table) {
      return; // シートが無い・列名が足りない → 何もしない(次に開いたとき、また試す)
    }
    const items = readMonthlyItems_(table);

    if (items.length && items.every(function (item) { return !item.active; })) {
      writeColumnRuns_(
        table.sheet,
        table.col['有効'] + 1,
        items.map(function (item) {
          item.active = true;
          return { rowNo: item.rowNo, value: true };
        }),
        null
      );
      // 「毎月かわる」も同じ理由で消えているはずなので、初期データで印が付いていた項目(光熱費)だけ戻す
      if (items.every(function (item) { return !item.varies; })) {
        const cells = [];
        items.forEach(function (item) {
          const wasVarying = DEFAULT_MONTHLY_ITEMS.some(function (d) {
            return d[3] === true && d[1] === item.kind && d[2] === item.name;
          });
          if (wasVarying) {
            item.varies = true;
            cells.push({ rowNo: item.rowNo, value: true });
          }
        });
        writeColumnRuns_(table.sheet, table.col['毎月かわる'] + 1, cells, null);
      }
    }

    const missing = [];
    USERS.forEach(function (user) {
      DEFAULT_TAX_ITEMS.forEach(function (name) {
        const exists = items.some(function (item) {
          return item.owner === user && item.kind === MONTHLY.TAX && item.name === name;
        });
        if (!exists) {
          missing.push({ owner: user, kind: MONTHLY.TAX, name: name, amount: 0, varies: true });
        }
      });
    });
    appendMonthlyItems_(table, items, missing);

    writeSetting_(
      fresh,
      SETTING_KEY.MONTHLY_READY,
      MONTHLY_READY_VALUE,
      '`毎月の項目` に税金・社会保険の項目を足した印です。この行を消すと、次にアプリを開いたときに、足りない項目をもういちど足します'
    );
  });
}

/** 項目名をととのえる。空・長すぎ・文字でないときは null */
function cleanItemName_(value) {
  const text = cleanText_(value);
  if (!text || countChars_(text) > MAX_ITEM_NAME_LENGTH) {
    return null;
  }
  return text;
}

/** 任意の金額: 空(null / '' / 0 / 無し)→ 0、正の整数 → その数、それ以外 → -1 */
function parseOptionalAmount_(value) {
  if (value === null || value === undefined || value === '' || value === 0) {
    return 0;
  }
  if (typeof value !== 'number' || !isFinite(value) || Math.floor(value) !== value || value < 0 || value > MAX_AMOUNT) {
    return -1;
  }
  return value;
}

/** `毎月の項目` の1行の、いくつかのマスを書く。patch は { name, amount, varies, active } のうち、変えるものだけ */
function writeMonthlyItemCells_(table, item, patch) {
  const sheet = table.sheet;
  const col = table.col;
  if (patch.name !== undefined) {
    sheet.getRange(item.rowNo, col['項目名'] + 1).setNumberFormat('@').setValue(patch.name);
  }
  if (patch.amount !== undefined) {
    sheet.getRange(item.rowNo, col['金額'] + 1).setNumberFormat('#,##0').setValue(patch.amount > 0 ? patch.amount : '');
  }
  if (patch.varies !== undefined) {
    sheet.getRange(item.rowNo, col['毎月かわる'] + 1).setValue(patch.varies);
  }
  if (patch.active !== undefined) {
    sheet.getRange(item.rowNo, col['有効'] + 1).setValue(patch.active);
  }
}

/** 書いたあとの最新の中身(sync と同じ)に、その action の結果を足して返す */
function withSyncPayload_(ctx, extra) {
  SpreadsheetApp.flush();
  const payload = syncPayload_(ctx);
  if (!payload.ok) {
    return payload;
  }
  Object.keys(extra).forEach(function (key) {
    payload[key] = extra[key];
  });
  return payload;
}

/**
 * addMonthlyItem: 毎月の項目を足す。
 *   リクエスト: { 持ち主, 区分, 項目名, 金額(任意), 毎月かわる(任意) }
 *   足せるのは、自分の項目か、共同口座の固定費だけ(相手の項目は forbidden)。
 *   同じ持ち主・区分・項目名の項目がすでにあれば、足さない(duplicate: true)。
 *   それが停止中なら、足さずに「有効」に戻す(revived: true)。送り直しても二重にならない。
 *   応答: { ok, id, duplicate, revived, …sync と同じ中身 }
 */
function handleAddMonthlyItem_(ctx) {
  const req = ctx.req;
  const owner = req['持ち主'];
  if (owner !== ctx.user && owner !== WALLET_JOINT) {
    return USERS.indexOf(owner) !== -1 ? { ok: false, error: 'forbidden' } : { ok: false, error: 'invalid', field: '持ち主' };
  }
  const kind = req['区分'];
  if (MONTHLY_KINDS.indexOf(kind) === -1 || (owner === WALLET_JOINT && kind !== MONTHLY.FIXED)) {
    return { ok: false, error: 'invalid', field: '区分' };
  }
  const name = cleanItemName_(req['項目名']);
  if (!name) {
    return { ok: false, error: 'invalid', field: '項目名' };
  }
  const amount = parseOptionalAmount_(req['金額']);
  if (amount < 0) {
    return { ok: false, error: 'invalid', field: '金額' };
  }
  const variesGiven = req['毎月かわる'];
  if (variesGiven !== undefined && variesGiven !== null && typeof variesGiven !== 'boolean') {
    return { ok: false, error: 'invalid', field: '毎月かわる' };
  }
  const varies = variesGiven === true;

  const table = openMonthlyItems_();
  if (!table) {
    return { ok: false, error: 'setup' };
  }
  const items = readMonthlyItems_(table);
  const same = items.filter(function (item) {
    return item.owner === owner && item.kind === kind && item.name === name;
  });
  const active = same.filter(function (item) {
    return item.active;
  })[0];
  if (active) {
    return withSyncPayload_(ctx, { id: active.id, duplicate: true, revived: false });
  }
  if (same.length) {
    writeMonthlyItemCells_(table, same[0], { amount: amount, varies: varies, active: true });
    return withSyncPayload_(ctx, { id: same[0].id, duplicate: false, revived: true });
  }
  const ids = appendMonthlyItems_(table, items, [{ owner: owner, kind: kind, name: name, amount: amount, varies: varies }]);
  return withSyncPayload_(ctx, { id: ids[0], duplicate: false, revived: false });
}

/**
 * updateMonthlyItem: 毎月の項目をなおす・停止する。
 *   リクエスト: { id, 項目名?, 金額?, 毎月かわる?, 有効? }(送ったものだけ変える。有効: false が「停止」)
 *   なおせるのは、持ち主(シートのいまの値)が本人か共同口座の項目だけ。持ち主と区分は変えられない。
 *   停止しても行は消さない。これまでの記録も残る。
 *   応答: { ok, id, updated, …sync と同じ中身 }
 */
function handleUpdateMonthlyItem_(ctx) {
  const req = ctx.req;
  if (typeof req.id !== 'string' || req.id === '' || req.id.length > 64) {
    return { ok: false, error: 'invalid', field: 'id' };
  }
  const table = openMonthlyItems_();
  if (!table) {
    return { ok: false, error: 'setup' };
  }
  const items = readMonthlyItems_(table);
  const item = items.filter(function (it) {
    return it.id === req.id;
  })[0];
  if (!item) {
    return { ok: false, error: 'invalid', field: 'id' };
  }
  if (item.owner !== ctx.user && item.owner !== WALLET_JOINT) {
    return { ok: false, error: 'forbidden' };
  }

  const patch = {};
  let name = item.name;
  if (req['項目名'] !== undefined) {
    name = cleanItemName_(req['項目名']);
    if (!name) {
      return { ok: false, error: 'invalid', field: '項目名' };
    }
    if (name !== item.name) {
      patch.name = name;
    }
  }
  if (req['金額'] !== undefined) {
    const amount = parseOptionalAmount_(req['金額']);
    if (amount < 0) {
      return { ok: false, error: 'invalid', field: '金額' };
    }
    if (amount !== item.amount) {
      patch.amount = amount;
    }
  }
  if (req['毎月かわる'] !== undefined) {
    if (typeof req['毎月かわる'] !== 'boolean') {
      return { ok: false, error: 'invalid', field: '毎月かわる' };
    }
    if (req['毎月かわる'] !== item.varies) {
      patch.varies = req['毎月かわる'];
    }
  }
  let active = item.active;
  if (req['有効'] !== undefined) {
    if (typeof req['有効'] !== 'boolean') {
      return { ok: false, error: 'invalid', field: '有効' };
    }
    active = req['有効'];
    if (active !== item.active) {
      patch.active = active;
    }
  }
  // 同じ持ち主・区分に、同じ名前の有効な項目が2つできないようにする
  if (active && (patch.name !== undefined || patch.active !== undefined)) {
    const clash = items.some(function (other) {
      return other.id !== item.id && other.active && other.owner === item.owner && other.kind === item.kind && other.name === name;
    });
    if (clash) {
      return { ok: false, error: 'invalid', field: '項目名', reason: 'duplicate' };
    }
  }

  const updated = Object.keys(patch).length > 0;
  if (updated) {
    writeMonthlyItemCells_(table, item, patch);
  }
  return withSyncPayload_(ctx, { id: item.id, updated: updated });
}

/**
 * closeMonth: 月を確定する(その月の固定費・貯蓄・収入・税金を `記録` に書く)。
 *   リクエスト: { 月: 'YYYY-MM', 金額: { 項目id: 円, … }, 消す: [項目id, …](任意) }
 *   対象は、持ち主(シートのいまの値)が本人か共同口座の項目だけ。相手の項目が入っていたら forbidden(何も書かない)。
 *
 *   記録の id は「auto-年月-項目id」(例: auto-202611-M001)。月と項目から決まるので、
 *   何度確定しても同じ行を書きかえるだけで、二重にならない。
 *     - 金額が正の数      → 無ければ足す。あれば金額などを書きかえる(削除の印が付いていたら外す = 復活)
 *     - 「消す」にある項目 → 記録があれば、削除の印を付ける
 *     - 金額が空 / 0      → 自分の項目は「消す」と同じ。共同口座の項目は、何もしない
 *                           (相手が入れた共同口座の金額を、自分が空のまま確定して消してしまわないため)
 *     - リクエストに無い項目 → 何もしない
 *   共同口座の項目は、あとから確定した人の値になる(後勝ち)。
 *   「毎月おなじ」の固定費・貯蓄で、金額がまだ登録されていない項目は、確定した金額を登録する(次の月から自動で入る)。
 *   確定のたびに `毎月の確定` を書く(同じ月・同じ人は1行。確定日時を新しくする)。
 *   応答: { ok, 月, 確定日時, written, removed, …sync と同じ中身 }
 */
function handleCloseMonth_(ctx) {
  const req = ctx.req;
  const user = ctx.user;
  const month = req['月'];
  if (!isValidMonthString_(month)) {
    return { ok: false, error: 'invalid', field: '月' };
  }
  const amounts = req['金額'];
  if (!amounts || typeof amounts !== 'object' || Array.isArray(amounts)) {
    return { ok: false, error: 'invalid', field: '金額' };
  }
  const removeList = req['消す'] === undefined || req['消す'] === null ? [] : req['消す'];
  if (!Array.isArray(removeList) || removeList.some(function (id) { return typeof id !== 'string'; })) {
    return { ok: false, error: 'invalid', field: '消す' };
  }
  const ids = Object.keys(amounts);
  removeList.forEach(function (id) {
    if (ids.indexOf(id) === -1) {
      ids.push(id);
    }
  });
  if (ids.length > MAX_CLOSE_ITEMS) {
    return { ok: false, error: 'invalid', field: '金額' };
  }

  const itemsTable = openMonthlyItems_();
  const table = openRecords_();
  const closedTable = openMonthlyClosed_();
  if (!itemsTable || !table || !closedTable) {
    return { ok: false, error: 'setup' };
  }
  const items = readMonthlyItems_(itemsTable);
  const byId = {};
  items.forEach(function (item) {
    if (!byId[item.id]) {
      byId[item.id] = item;
    }
  });

  // --- まず全部たしかめる(1つでもだめなら、何も書かない) ---
  const plan = []; // { item, amount }  amount: 正の数 = 書く / 0 = 消す
  for (let i = 0; i < ids.length; i++) {
    const item = Object.prototype.hasOwnProperty.call(byId, ids[i]) ? byId[ids[i]] : null;
    if (!item || MONTHLY_KINDS.indexOf(item.kind) === -1) {
      return { ok: false, error: 'invalid', field: '金額', id: ids[i] };
    }
    if (item.owner !== user && item.owner !== WALLET_JOINT) {
      return { ok: false, error: 'forbidden', id: ids[i] };
    }
    if (removeList.indexOf(item.id) !== -1) {
      plan.push({ item: item, amount: 0 });
      continue;
    }
    const amount = parseOptionalAmount_(amounts[item.id]);
    if (amount < 0) {
      return { ok: false, error: 'invalid', field: '金額', id: item.id };
    }
    if (amount > 0) {
      plan.push({ item: item, amount: amount });
    } else if (item.owner === user) {
      plan.push({ item: item, amount: 0 });
    }
    // 共同口座の項目が空 → 何もしない
  }

  // --- `記録` に書く内容を決める ---
  const col = table.col;
  const now = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
  const yearMonth = month.replace('-', '');
  const appends = [];
  const cells = {}; // 列名 → [{ rowNo, value }]
  const MANAGED = ['財布', '種類', '項目', '金額', '記録した人', '削除'];
  MANAGED.forEach(function (name) {
    cells[name] = [];
  });
  let written = 0;
  let removed = 0;
  const register = []; // `毎月の項目` の金額に登録する分 { rowNo, value }

  plan.forEach(function (p) {
    const item = p.item;
    const id = AUTO_ID_PREFIX + yearMonth + '-' + item.id;
    const rowNo = findRecordRow_(table, id);
    if (p.amount > 0 && !item.varies && item.amount === 0 && (item.kind === MONTHLY.FIXED || item.kind === MONTHLY.SAVING)) {
      register.push({ rowNo: item.rowNo, value: p.amount });
    }
    if (rowNo < 0) {
      if (p.amount > 0) {
        appends.push({
          'id': id,
          '作成日時': now,
          '日付': month + '-01',
          '月': month,
          '財布': item.owner,
          '種類': item.kind,
          '項目': item.name,
          'メモ': '',
          '金額': p.amount,
          '記録した人': user,
          '元': SOURCE_AUTO,
          '削除': '',
        });
        written += 1;
      }
      return;
    }
    const row = table.values[rowNo - 1];
    const deleted = isDeleted_(row[col['削除']]);
    if (p.amount > 0) {
      const next = { '財布': item.owner, '種類': item.kind, '項目': item.name, '金額': p.amount, '削除': '' };
      let changed = false;
      Object.keys(next).forEach(function (name) {
        const current = row[col[name]];
        const same = name === '金額' ? toAmount_(current) === next[name] : name === '削除' ? !deleted : String(current).trim() === next[name];
        if (!same) {
          cells[name].push({ rowNo: rowNo, value: next[name] });
          changed = true;
        }
      });
      if (changed) {
        // 中身を変えた人を、記録した人にする(変わっていなければ、前に確定した人のまま)
        if (String(row[col['記録した人']]) !== user) {
          cells['記録した人'].push({ rowNo: rowNo, value: user });
        }
        written += 1;
      }
    } else if (!deleted) {
      cells['削除'].push({ rowNo: rowNo, value: DELETED_MARK });
      if (String(row[col['記録した人']]) !== user) {
        cells['記録した人'].push({ rowNo: rowNo, value: user });
      }
      removed += 1;
    }
  });

  // --- まとめて書く ---
  MANAGED.forEach(function (name) {
    writeColumnRuns_(table.sheet, col[name] + 1, cells[name], name === '金額' ? '#,##0' : '@');
  });
  appendRecords_(table, appends);
  writeColumnRuns_(itemsTable.sheet, itemsTable.col['金額'] + 1, register, '#,##0');
  writeMonthlyClosed_(closedTable, month, user, now);

  return withSyncPayload_(ctx, { '月': month, '確定日時': now, written: written, removed: removed });
}

/** `毎月の確定` に書く。同じ月・同じ人の行があれば確定日時だけ新しくし、無ければ1行足す */
function writeMonthlyClosed_(table, month, user, now) {
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || TZ;
  const sheet = table.sheet;
  const col = table.col;
  for (let r = 1; r < table.values.length; r++) {
    const row = table.values[r];
    if (toMonthString_(row[col['月']], '', tz) === month && String(row[col['確定した人']]).trim() === user) {
      sheet.getRange(r + 1, col['確定日時'] + 1).setNumberFormat('@').setValue(now);
      return;
    }
  }
  const indexes = HEADERS.MONTHLY_CLOSED.map(function (name) {
    return col[name];
  });
  const first = Math.min.apply(null, indexes);
  const width = Math.max.apply(null, indexes) - first + 1;
  const values = [];
  const formats = [];
  for (let i = 0; i < width; i++) {
    values.push('');
    formats.push('@');
  }
  values[col['月'] - first] = month;
  values[col['確定した人'] - first] = user;
  values[col['確定日時'] - first] = now;
  const rowNo = Math.max(sheet.getLastRow(), 1) + 1;
  if (rowNo > sheet.getMaxRows()) {
    sheet.insertRowsAfter(sheet.getMaxRows(), 50);
  }
  sheet.getRange(rowNo, first + 1, 1, width).setNumberFormats([formats]).setValues([values]);
}

// ============================================================================
// `記録` シートの読み書き
// ============================================================================

/**
 * `記録` シートを読む。シートが無い・列名が足りないときは null。
 * 列は名前で探す(人が列を入れ替えたり、右に列を足したりしても壊れないように)。
 * @return {{sheet: Sheet, values: Array[], col: Object, timeZone: string}|null}
 *   col は「列名 → 0始まりの位置」
 */
function openRecords_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET.RECORDS);
  if (!sheet) {
    return null;
  }
  const values = sheet.getDataRange().getValues();
  const header = (values[0] || []).map(function (name) {
    return String(name).trim();
  });
  const col = {};
  for (let i = 0; i < HEADERS.RECORDS.length; i++) {
    const name = HEADERS.RECORDS[i];
    const index = header.indexOf(name);
    if (index === -1) {
      return null;
    }
    col[name] = index;
  }
  return { sheet: sheet, values: values, col: col, timeZone: ss.getSpreadsheetTimeZone() || TZ };
}

/** id の行番号(1始まり)を返す。無ければ -1 */
function findRecordRow_(table, id) {
  const c = table.col['id'];
  for (let r = 1; r < table.values.length; r++) {
    if (String(table.values[r][c]).trim() === id) {
      return r + 1;
    }
  }
  return -1;
}

/**
 * いちばん下に1行足す。
 * 金額以外は「書式なしテキスト」にしてから書く
 * (2026-11-13 や 2026-11 が、勝手に日付の型へ変わるのを防ぐ。タイムゾーンずれ対策)。
 * シートを作り直さなくてよいように、書式は書き込む行にだけ設定する。
 */
function appendRecord_(table, record) {
  appendRecords_(table, [record]);
}

/** いちばん下に、まとめて足す(1回の書き込みで済ませる)。書式は appendRecord_ の説明のとおり */
function appendRecords_(table, records) {
  if (!records.length) {
    return;
  }
  const sheet = table.sheet;
  const indexes = HEADERS.RECORDS.map(function (name) {
    return table.col[name];
  });
  const first = Math.min.apply(null, indexes);
  const last = Math.max.apply(null, indexes);
  const width = last - first + 1;

  const values = [];
  const formats = [];
  records.forEach(function (record) {
    const rowValues = [];
    const rowFormats = [];
    for (let i = 0; i < width; i++) {
      rowValues.push('');
      rowFormats.push('@');
    }
    HEADERS.RECORDS.forEach(function (name) {
      rowValues[table.col[name] - first] = record[name];
    });
    rowFormats[table.col['金額'] - first] = '#,##0';
    values.push(rowValues);
    formats.push(rowFormats);
  });

  const rowNo = Math.max(sheet.getLastRow(), 1) + 1;
  const lastRowNo = rowNo + records.length - 1;
  if (lastRowNo > sheet.getMaxRows()) {
    sheet.insertRowsAfter(sheet.getMaxRows(), lastRowNo - sheet.getMaxRows() + 200);
  }
  sheet.getRange(rowNo, first + 1, records.length, width).setNumberFormats(formats).setValues(values);
}

/** 削除されていない記録を、すべて返す(型のゆれは、ここでそろえる) */
function listRecords_(table) {
  const col = table.col;
  const tz = table.timeZone;
  const list = [];
  for (let r = 1; r < table.values.length; r++) {
    const row = table.values[r];
    const id = String(row[col['id']]).trim();
    if (!id || isDeleted_(row[col['削除']])) {
      continue;
    }
    const date = toDateString_(row[col['日付']], tz);
    list.push({
      'id': id,
      '作成日時': toDateTimeString_(row[col['作成日時']], tz),
      '日付': date,
      '月': toMonthString_(row[col['月']], date, tz),
      '財布': String(row[col['財布']]).trim(),
      '種類': String(row[col['種類']]).trim(),
      '項目': String(row[col['項目']]).trim(),
      'メモ': String(row[col['メモ']]).trim(),
      '金額': toAmount_(row[col['金額']]),
      '記録した人': String(row[col['記録した人']]).trim(),
      '元': String(row[col['元']]).trim(),
    });
  }
  return list;
}

/** Date 型かどうか(セルに日付の型で入っている場合) */
function isDate_(value) {
  return Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime());
}

function pad2_(n) {
  return ('0' + n).slice(-2);
}

/** 'YYYY-MM-DD' にそろえる(Date 型や 2026/1/5 のような書き方が混じっていても壊れない) */
function toDateString_(value, tz) {
  if (isDate_(value)) {
    return Utilities.formatDate(value, tz, 'yyyy-MM-dd');
  }
  const text = String(value === null || value === undefined ? '' : value).trim();
  const m = text.match(/^(\d{4})[-\/.年](\d{1,2})[-\/.月](\d{1,2})/);
  return m ? m[1] + '-' + pad2_(m[2]) + '-' + pad2_(m[3]) : text;
}

/** 'YYYY-MM' にそろえる。読めなければ、日付から作る */
function toMonthString_(value, dateString, tz) {
  if (isDate_(value)) {
    return Utilities.formatDate(value, tz, 'yyyy-MM');
  }
  const text = String(value === null || value === undefined ? '' : value).trim();
  const m = text.match(/^(\d{4})[-\/.年](\d{1,2})/);
  if (m) {
    return m[1] + '-' + pad2_(m[2]);
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(dateString) ? dateString.slice(0, 7) : '';
}

/** 'YYYY-MM-DD HH:mm:ss' にそろえる */
function toDateTimeString_(value, tz) {
  if (isDate_(value)) {
    return Utilities.formatDate(value, tz, 'yyyy-MM-dd HH:mm:ss');
  }
  return String(value === null || value === undefined ? '' : value).trim();
}

/** 金額を数値にする("1,200" のような文字でも読む。読めなければ 0) */
function toAmount_(value) {
  if (typeof value === 'number') {
    return isFinite(value) ? Math.round(value) : 0;
  }
  const n = Number(String(value).replace(/[,\s¥円]/g, ''));
  return isFinite(n) ? Math.round(n) : 0;
}

/** 「削除」列に印があるか(空・FALSE 以外は削除済みと見なす) */
function isDeleted_(value) {
  if (value === true) {
    return true;
  }
  if (value === false || value === null || value === undefined) {
    return false;
  }
  const text = String(value).trim();
  return text !== '' && text.toUpperCase() !== 'FALSE' && text !== '0';
}

// ============================================================================
// 入力の検証
// ============================================================================

/** id は、端末が作る UUID など(半角英数字と - _ で 8〜64 文字) */
function isValidId_(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id);
}

/** 実在する日付の 'YYYY-MM-DD' か(2000〜2100年) */
function isValidDateString_(text) {
  if (typeof text !== 'string') {
    return false;
  }
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    return false;
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 2000 || y > 2100) {
    return false;
  }
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/**
 * 項目・メモの文字をととのえる。文字でない・長すぎるときは null。
 * 先頭の「=」は全角にする(シートで数式として動いてしまうのを防ぐ)。
 */
function cleanText_(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value !== 'string') {
    return null;
  }
  let text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (countChars_(text) > MAX_TEXT_LENGTH) {
    return null;
  }
  if (text.charAt(0) === '=') {
    text = '＝' + text.slice(1);
  }
  return text;
}

/**
 * addRecord の中身をたしかめる。
 * @return {{record: Object}|{field: string}} だめなときは、だめだった項目名を field に入れる
 */
function validateRecord_(req, user) {
  // auto- ではじまる id は、毎月の設定の確定で使う(アプリの入力からは作らせない)
  if (!isValidId_(req.id) || req.id.indexOf(AUTO_ID_PREFIX) === 0) {
    return { field: 'id' };
  }
  if (!isValidDateString_(req['日付'])) {
    return { field: '日付' };
  }
  const kind = req['種類'];
  if (APP_KINDS.indexOf(kind) === -1) {
    return { field: '種類' };
  }
  const amount = req['金額'];
  if (typeof amount !== 'number' || !isFinite(amount) || Math.floor(amount) !== amount || amount <= 0 || amount > MAX_AMOUNT) {
    return { field: '金額' };
  }

  // 財布: 自分か共同口座だけ。「共同へ入金」は、いつも自分の財布から
  let wallet = req['財布'];
  if (kind === KIND.DEPOSIT) {
    wallet = user;
  } else if (wallet !== user && wallet !== WALLET_JOINT) {
    return { field: '財布' };
  }

  let item = '';
  let memo = '';
  if (kind === KIND.VARIABLE) {
    item = cleanText_(req['項目']);
    if (!item) {
      return { field: '項目' };
    }
  } else if (kind === KIND.SPECIAL) {
    memo = cleanText_(req['メモ']);
    if (!memo) {
      return { field: 'メモ' };
    }
  }

  return { record: { id: req.id, date: req['日付'], wallet: wallet, kind: kind, item: item, memo: memo, amount: amount } };
}

// ============================================================================
// ④ フォームの回答を取り込む / ⑤ 月ごとの集計を見る
// ============================================================================

/**
 * フォームの回答シートを読んで、`記録` に足す。
 *   - 回答シートは読むだけ(getValues / getFormUrl / getName しか呼ばない)。
 *   - id は回答のタイムスタンプから作るので、何度実行しても二重にならない。
 *     `記録` にその id の行があれば(削除の印が付いていても)足さない
 *     → アプリで消した記録が、取り込みのやり直しで復活することはない。
 */
function importFormResponses() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!openRecords_()) {
    notify_('`' + SHEET.RECORDS + '` シートが見つかりません(または列名が足りません)。\nさきに、メニューの「① 初期設定」を実行してください。');
    return;
  }

  const found = findFormSheet_(ss);
  if (!found.sheet) {
    notify_(found.message);
    return;
  }
  const sheetName = found.sheet.getName();
  const values = found.sheet.getDataRange().getValues();
  const mapping = mapFormColumns_(values[0] || []);
  if (mapping.missing.length) {
    notify_(
      '回答シート「' + sheetName + '」で、つぎの列が見つかりませんでした。取り込みは行っていません。\n' +
        mapping.missing.map(function (name) {
          return '  ・' + name;
        }).join('\n') +
        '\n\n実際の見出し(1行目):\n' +
        describeHeaders_(values[0] || [])
    );
    return;
  }

  const tz = ss.getSpreadsheetTimeZone() || TZ;
  const parsed = parseFormRows_(values, mapping.col, tz);

  const result = withLock_(function () {
    const table = openRecords_();
    if (!table) {
      return null;
    }
    // 削除の印が付いた行も含めて、すでにある id は足さない
    const existing = {};
    for (let r = 1; r < table.values.length; r++) {
      const id = String(table.values[r][table.col['id']]).trim();
      if (id) {
        existing[id] = true;
      }
    }
    const fresh = parsed.records.filter(function (record) {
      return !existing[record['id']];
    });
    appendRecords_(table, fresh);
    return { added: fresh.length, already: parsed.records.length - fresh.length };
  });
  if (!result) {
    notify_('`' + SHEET.RECORDS + '` シートを読めませんでした。取り込みは行っていません。');
    return;
  }

  const lines = [];
  lines.push('回答シート「' + sheetName + '」から取り込みました。(回答シートは書きかえていません)');
  lines.push('');
  lines.push('今回あたらしく取り込んだ: ' + result.added + '件');
  lines.push('すでに取り込み済みで飛ばした: ' + result.already + '件');
  lines.push('取り込めずに飛ばした行: ' + parsed.skipped.length + '件');
  pushLimited_(lines, parsed.skipped.map(function (item) {
    return '  ・' + item.row + '行目: ' + item.reason;
  }));
  if (parsed.notes.length) {
    lines.push('');
    lines.push('取り込んだが、確認してほしい行: ' + parsed.notes.length + '件');
    pushLimited_(lines, parsed.notes.map(function (item) {
      return '  ・' + item.row + '行目: ' + item.reason;
    }));
  }
  lines.push('');
  lines.push('使った列: ' + mapping.used.join(' / '));
  lines.push('');
  lines.push(buildSummaryText_());
  notify_(lines.join('\n'));
}

/** ⑤ `記録` の、削除されていない全件を、月×財布×種類ごとに数えて出す(手集計との照合用) */
function showMonthlySummary() {
  if (!openRecords_()) {
    notify_('`' + SHEET.RECORDS + '` シートが見つかりません(または列名が足りません)。\nさきに、メニューの「① 初期設定」を実行してください。');
    return;
  }
  notify_(buildSummaryText_());
}

/** 行が多いときは、先頭の REPORT_MAX_LINES 行だけ出して「ほか◯件」とする */
function pushLimited_(lines, items) {
  items.slice(0, REPORT_MAX_LINES).forEach(function (text) {
    lines.push(text);
  });
  if (items.length > REPORT_MAX_LINES) {
    lines.push('  …ほか ' + (items.length - REPORT_MAX_LINES) + '件');
  }
}

/** 見出しを比べやすい形にする(全角・半角をそろえ、空白と改行を取る) */
function normalizeHeader_(value) {
  return String(value === null || value === undefined ? '' : value).normalize('NFKC').replace(/\s+/g, '');
}

/** 列番号(0始まり)を A, B, … AA の形にする */
function columnLetter_(index) {
  let n = index + 1;
  let text = '';
  while (n > 0) {
    const rest = (n - 1) % 26;
    text = String.fromCharCode(65 + rest) + text;
    n = Math.floor((n - 1) / 26);
  }
  return text;
}

/** 見出しの一覧を「A列: タイムスタンプ」の形で並べる */
function describeHeaders_(headerRow) {
  const lines = [];
  headerRow.forEach(function (value, i) {
    const text = String(value === null || value === undefined ? '' : value).trim();
    lines.push('  ' + columnLetter_(i) + '列: ' + (text === '' ? '(空)' : text));
  });
  return lines.length ? lines.join('\n') : '  (見出しがありません)';
}

/** 1行目に「タイムスタンプ」と「使用者」を含む見出しがあるか */
function looksLikeFormSheet_(sheet) {
  const header = (sheet.getDataRange().getValues()[0] || []).map(normalizeHeader_);
  const has = function (word) {
    return header.some(function (name) {
      return name.indexOf(word) !== -1;
    });
  };
  return has('タイムスタンプ') && has('使用者');
}

/**
 * フォームの回答シートを探す(名前は決め打ちしない)。
 *   1. フォームとつながっているシート(getFormUrl がある)が1つだけなら、それ
 *   2. 0個または複数のときは、見出しに「タイムスタンプ」「使用者」があるシートが1つだけなら、それ
 *   3. それでも決まらなければ、理由を message に入れて返す
 * アプリ用の5シートは、候補にしない。
 * @return {{sheet: Sheet}|{sheet: null, message: string}}
 */
function findFormSheet_(ss) {
  const appNames = Object.keys(SHEET).map(function (key) {
    return SHEET[key];
  });
  const others = ss.getSheets().filter(function (sheet) {
    return appNames.indexOf(sheet.getName()) === -1;
  });
  const linked = others.filter(function (sheet) {
    try {
      return Boolean(sheet.getFormUrl());
    } catch (err) {
      return false;
    }
  });
  if (linked.length === 1) {
    return { sheet: linked[0] };
  }

  const pool = linked.length > 1 ? linked : others;
  const byHeader = pool.filter(looksLikeFormSheet_);
  if (byHeader.length === 1) {
    return { sheet: byHeader[0] };
  }

  const names = function (list) {
    return list.map(function (sheet) {
      return '「' + sheet.getName() + '」';
    }).join('、');
  };
  if (byHeader.length > 1) {
    return {
      sheet: null,
      message:
        'フォームの回答シートの候補が複数あって、どれを取り込むか決められませんでした。取り込みは行っていません。\n候補: ' +
        names(byHeader) +
        '\n\n取り込むシート以外の名前を教えてもらえれば、対応します。',
    };
  }
  return {
    sheet: null,
    message:
      'フォームの回答シートが見つかりませんでした。取り込みは行っていません。\n' +
      '(フォームとつながっているシートか、1行目に「タイムスタンプ」と「使用者」があるシートを探しました)\n\n' +
      'このスプレッドシートにあるシート: ' +
      (others.length ? names(others) : '(アプリ用のシートだけ)'),
  };
}

/**
 * 回答シートの列を、見出しの名前で探す(完全一致でなく「含む」)。
 *   「金額を入力」は同じ名前で2つあるので、左から1つ目 = 変動費の金額、2つ目 = 特別費の金額。
 *   (見出しに「変動」「特別」と書き分けてあれば、そちらを優先する)
 * @return {{col: Object, missing: string[], used: string[]}}
 *   col … { timestamp, wallet, kind, category, memo, amountVariable, amountSpecial }(0始まり)
 */
function mapFormColumns_(headerRow) {
  const header = headerRow.map(normalizeHeader_);
  const taken = {};
  const col = {};
  const missing = [];
  const used = [];

  const take = function (key, label, index) {
    if (index === -1) {
      missing.push(label);
      return;
    }
    col[key] = index;
    taken[index] = true;
    used.push(label + '=' + columnLetter_(index) + '列');
  };
  /** まだ使っていない列から、条件に合う、いちばん左の列を探す */
  const find = function (test) {
    for (let i = 0; i < header.length; i++) {
      if (!taken[i] && header[i] !== '' && test(header[i])) {
        return i;
      }
    }
    return -1;
  };
  const includes = function (word) {
    return function (name) {
      return name.indexOf(word) !== -1;
    };
  };
  /** 完全一致を先に、なければ「含む」 */
  const findWord = function (word) {
    const exact = find(function (name) {
      return name === word;
    });
    return exact !== -1 ? exact : find(includes(word));
  };

  take('timestamp', 'タイムスタンプ', findWord('タイムスタンプ'));
  take('wallet', '使用者', findWord('使用者'));

  // 金額の列(2つ)
  const amounts = [];
  header.forEach(function (name, i) {
    if (!taken[i] && name.indexOf('金額') !== -1) {
      amounts.push(i);
    }
  });
  let amountVariable = -1;
  let amountSpecial = -1;
  if (amounts.length >= 2) {
    const special = amounts.filter(function (i) {
      return header[i].indexOf('特別') !== -1;
    });
    const variable = amounts.filter(function (i) {
      return header[i].indexOf('変動') !== -1;
    });
    if (special.length === 1 && variable.length === 1 && special[0] !== variable[0]) {
      amountVariable = variable[0];
      amountSpecial = special[0];
    } else {
      amountVariable = amounts[0];
      amountSpecial = amounts[1];
    }
  } else if (amounts.length === 1) {
    amountVariable = amounts[0];
  }
  take('amountVariable', '金額を入力(1つ目 = 変動費の金額)', amountVariable);
  take('amountSpecial', '金額を入力(2つ目 = 特別費の金額)', amountSpecial);

  take('kind', '種類', findWord('種類'));
  take('category', '変動費を入力(カテゴリ)', find(function (name) {
    return name.indexOf('変動費') !== -1 || name.indexOf('カテゴリ') !== -1;
  }));
  take('memo', '特別費内容', find(includes('特別費')));

  return { col: col, missing: missing, used: used };
}

/**
 * タイムスタンプを読む。Date 型でも、'2026/10/19 12:34:56' のような文字でもよい。
 * @return {{dateTime: string, key: string}|null}
 *   dateTime … 'YYYY-MM-DD HH:mm:ss' / key … id に使う 'YYYYMMDDHHmmssSSS'(ミリ秒まで)
 */
function parseFormTimestamp_(value, tz) {
  if (isDate_(value)) {
    const ms = ('00' + value.getMilliseconds()).slice(-3);
    return {
      dateTime: Utilities.formatDate(value, tz, 'yyyy-MM-dd HH:mm:ss'),
      key: Utilities.formatDate(value, tz, 'yyyyMMddHHmmss') + ms,
    };
  }
  const text = String(value === null || value === undefined ? '' : value).normalize('NFKC').trim();
  const m = text.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:[ T]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (!m) {
    return null;
  }
  const date = m[1] + '-' + pad2_(m[2]) + '-' + pad2_(m[3]);
  if (!isValidDateString_(date)) {
    return null;
  }
  const time = [pad2_(m[4] || 0), pad2_(m[5] || 0), pad2_(m[6] || 0)];
  if (Number(time[0]) > 23 || Number(time[1]) > 59 || Number(time[2]) > 59) {
    return null;
  }
  return {
    dateTime: date + ' ' + time.join(':'),
    key: date.replace(/-/g, '') + time.join('') + '000',
  };
}

/**
 * 回答の金額を読む。
 * @return {{amount: number}|{problem: string}}
 */
function parseFormAmount_(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return { problem: '空' };
  }
  let n;
  if (typeof value === 'number') {
    n = value;
  } else {
    const text = String(value).normalize('NFKC').replace(/[,\s¥\\円]/g, '');
    n = /^\d+(\.\d+)?$/.test(text) ? Number(text) : NaN;
  }
  if (!isFinite(n)) {
    return { problem: '数値でない(' + String(value).slice(0, 20) + ')' };
  }
  if (n === 0) {
    return { problem: '0' };
  }
  if (n < 0 || Math.floor(n) !== n) {
    return { problem: '正の整数でない(' + n + ')' };
  }
  if (n > MAX_AMOUNT) {
    return { problem: '大きすぎる(' + n + ')' };
  }
  return { amount: n };
}

/** 取り込む文字をととのえる(長すぎる分は切る) */
function cleanFormText_(value) {
  const text = String(value === null || value === undefined ? '' : value);
  const cleaned = cleanText_(Array.from(text.trim()).slice(0, MAX_TEXT_LENGTH).join(''));
  return cleaned === null ? '' : cleaned;
}

/**
 * 回答シートの中身を、`記録` に足す形へ直す(ここでは何も書かない)。
 * @return {{records: Object[], skipped: Object[], notes: Object[]}}
 *   skipped / notes は { row: 回答シートの行番号, reason: 理由 }
 */
function parseFormRows_(values, col, tz) {
  const wallets = USERS.concat([WALLET_JOINT]);
  const records = [];
  const skipped = [];
  const notes = [];
  const seen = {}; // 同じタイムスタンプが何回出てきたか

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const rowNo = r + 1;
    const blank = row.every(function (cell) {
      return cell === null || cell === undefined || String(cell).trim() === '';
    });
    if (blank) {
      continue; // 空の行は、だまって飛ばす
    }

    const stamp = parseFormTimestamp_(row[col.timestamp], tz);
    if (!stamp) {
      skipped.push({ row: rowNo, reason: 'タイムスタンプが読めない' });
      continue;
    }
    // id: 同じタイムスタンプが複数あっても重ならないよう、2つ目からは -2, -3 … を付ける。
    // (飛ばす行も数に入れる。あとでその行が直されても、ほかの行の id がずれないように)
    seen[stamp.key] = (seen[stamp.key] || 0) + 1;
    const id = FORM_ID_PREFIX + stamp.key + (seen[stamp.key] > 1 ? '-' + seen[stamp.key] : '');

    const wallet = String(row[col.wallet]).normalize('NFKC').trim();
    if (wallets.indexOf(wallet) === -1) {
      skipped.push({ row: rowNo, reason: '使用者が不明(' + (wallet === '' ? '空' : wallet.slice(0, 20)) + ')' });
      continue;
    }
    const kind = String(row[col.kind]).normalize('NFKC').trim();
    if (FORM_KINDS.indexOf(kind) === -1) {
      skipped.push({ row: rowNo, reason: '種類が不明(' + (kind === '' ? '空' : kind.slice(0, 20)) + ')' });
      continue;
    }

    const isVariable = kind === KIND.VARIABLE;
    const amount = parseFormAmount_(row[isVariable ? col.amountVariable : col.amountSpecial]);
    if (amount.problem) {
      // もう片方の金額の列に数字があれば、手で確かめやすいように書き添える
      const other = parseFormAmount_(row[isVariable ? col.amountSpecial : col.amountVariable]);
      const hint = other.problem ? '' : '。' + (isVariable ? '特別費' : '変動費') + 'の金額の列には ' + other.amount + ' あり';
      skipped.push({ row: rowNo, reason: kind + 'の金額が' + amount.problem + hint });
      continue;
    }

    let item = '';
    let memo = '';
    if (isVariable) {
      item = cleanFormText_(row[col.category]);
      if (!item) {
        item = FORM_EMPTY_ITEM;
        notes.push({ row: rowNo, reason: 'カテゴリが空だったので「' + FORM_EMPTY_ITEM + '」として取り込み' });
      }
    } else {
      memo = cleanFormText_(row[col.memo]);
      if (!memo) {
        memo = FORM_EMPTY_MEMO;
        notes.push({ row: rowNo, reason: '特別費の内容が空だったので「' + FORM_EMPTY_MEMO + '」として取り込み' });
      }
    }

    const date = stamp.dateTime.slice(0, 10);
    records.push({
      'id': id,
      '作成日時': stamp.dateTime,
      '日付': date,
      '月': date.slice(0, 7),
      '財布': wallet,
      '種類': kind,
      '項目': item,
      'メモ': memo,
      '金額': amount.amount,
      '記録した人': wallet === WALLET_JOINT ? '' : wallet,
      '元': SOURCE_FORM,
      '削除': '',
    });
  }
  return { records: records, skipped: skipped, notes: notes };
}

/** 1200 → '¥1,200' */
function yen_(n) {
  return '¥' + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * `記録` の削除されていない全件を、月×財布×種類ごとに数える。
 * @return {Object[]} { month, wallet, kind, count, total, formCount, formTotal }(月 → 財布 → 種類 の順)
 */
function summarizeRecords_(table) {
  const groups = {};
  listRecords_(table).forEach(function (record) {
    const key = [record['月'], record['財布'], record['種類']].join('\t');
    if (!groups[key]) {
      groups[key] = { month: record['月'], wallet: record['財布'], kind: record['種類'], count: 0, total: 0, formCount: 0, formTotal: 0 };
    }
    const g = groups[key];
    g.count += 1;
    g.total += record['金額'];
    if (record['元'] === SOURCE_FORM) {
      g.formCount += 1;
      g.formTotal += record['金額'];
    }
  });

  const walletOrder = USERS.concat([WALLET_JOINT]);
  const kindOrder = [KIND.VARIABLE, KIND.SPECIAL, KIND.DEPOSIT].concat(MONTHLY_KINDS);
  const rank = function (list, value) {
    const i = list.indexOf(value);
    return i === -1 ? list.length : i;
  };
  return Object.keys(groups)
    .map(function (key) {
      return groups[key];
    })
    .sort(function (a, b) {
      if (a.month !== b.month) {
        return a.month < b.month ? -1 : 1;
      }
      const w = rank(walletOrder, a.wallet) - rank(walletOrder, b.wallet);
      if (w !== 0) {
        return w;
      }
      const k = rank(kindOrder, a.kind) - rank(kindOrder, b.kind);
      if (k !== 0) {
        return k;
      }
      return a.wallet + a.kind < b.wallet + b.kind ? -1 : 1;
    });
}

/** 集計を、お知らせに出す文字にする */
function buildSummaryText_() {
  const table = openRecords_();
  if (!table) {
    return '`' + SHEET.RECORDS + '` シートを読めませんでした。';
  }
  const rows = summarizeRecords_(table);
  const lines = ['【月ごとの集計】`' + SHEET.RECORDS + '` の、削除されていない全件', '月 / 財布 / 種類: 件数 合計(うち フォーム取り込み分)'];
  if (!rows.length) {
    lines.push('', '記録は、まだありません。');
    return lines.join('\n');
  }
  let month = null;
  rows.forEach(function (g) {
    if (g.month !== month) {
      month = g.month;
      lines.push('', '■ ' + (month || '(月が空)'));
    }
    lines.push(
      '  ' + (g.wallet || '(財布が空)') + ' / ' + (g.kind || '(種類が空)') + ': ' +
        g.count + '件 ' + yen_(g.total) +
        '(うちフォーム ' + g.formCount + '件 ' + yen_(g.formTotal) + ')'
    );
  });
  return lines.join('\n');
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
