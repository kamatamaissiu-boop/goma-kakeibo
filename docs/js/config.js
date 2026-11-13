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
export const APP_VERSION = "0.1.1";

// 保存先の応答を待つ上限(ミリ秒)。GAS は 1〜3 秒かかるのがふつう。
export const API_TIMEOUT_MS = 20000;
