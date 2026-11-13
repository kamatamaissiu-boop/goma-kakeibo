// ごまちゃん家計簿 設定
//
// GAS_URL: Google Apps Script を「ウェブアプリ」としてデプロイしたときに出る URL。
//   例) "https://script.google.com/macros/s/xxxxxxxxxxxxxxxx/exec"
//   空文字のままだと「まだ保存先とつながっていません」と表示されます。
//   ※ この URL は公開されても問題ありません(合言葉がないとデータは返りません)。
//   ※ ここを書きかえたときも、下の APP_VERSION と sw.js の APP_VERSION を上げること
//     (上げないと、iPhone に残っている古いファイルがしばらく使われます)。
export const GAS_URL = "https://script.google.com/macros/s/AKfycbxdp_xKo1NvvfIURDxlb1MsgCZ7YTXP4LLjOx8dUqSKcbCXwb2x-_CFuPEesz4mdIxW0w/exec";

// アプリの版。このファイルを含め、画面のファイルを直したら sw.js の APP_VERSION と一緒に上げる。
export const APP_VERSION = "0.6.0";

// 変動費のカテゴリの初期値。ふだんは保存先(`設定` シートの E列)から取った一覧を使い、
// まだ一度も取れていないときだけ、これを出す。gas/Code.gs の DEFAULT_CATEGORIES と同じ並びにする。
export const DEFAULT_CATEGORIES = Object.freeze([
  "食費", "生活必需品", "交際費", "交通費", "病院", "衣類", "雑貨", "美容系", "娯楽費", "ごまちゃん",
]);

// 使う人(保存先の gas/Code.gs の USERS と同じ並び。共同口座の入金の内訳は、この順に出す)
export const USERS = Object.freeze(["ゆうき", "まゆ"]);

// 共同口座の財布の名前(保存先と同じ文字にする)
export const WALLET_JOINT = "共同口座";

// 特別費の「まえに書いた内容から選ぶ」に出す数
export const MEMO_SUGGESTION_COUNT = 5;

// 保存先の応答を待つ上限(ミリ秒)。GAS は 1〜3 秒かかるのがふつう。
export const API_TIMEOUT_MS = 20000;

// --- アルバム(写真) ---
// 写真を足すとき、画面の側で、この大きさの JPEG に縮めてから送る(長辺のピクセル数 / 品質 / 1枚の目安のバイト数)。
// 目安より大きくなった写真だけ、品質と大きさを少しずつ下げて作り直す。
export const PHOTO_MAX_SIDE = 1200;
export const PHOTO_QUALITY = 0.8;
export const PHOTO_TARGET_BYTES = 350 * 1024;
// 写真のやりとり(1枚 300KB ほど)を待つ上限(ミリ秒)。ふつうの通信より長めにする
export const PHOTO_TIMEOUT_MS = 60000;
