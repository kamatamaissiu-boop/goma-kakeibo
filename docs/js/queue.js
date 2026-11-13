// 未送信キュー: 記録は、まず端末(localStorage)に積んでから、裏で保存先へ送る。
//
// キューの中身(古い順の配列)
//   { key, op: "add",    user, record: {id, 日付, 財布, 種類, 項目, メモ, 金額}, createdAt, tried }
//   { key, op: "update", user, record: {id, 日付, 財布, 種類, 項目, メモ, 金額}, createdAt, tried }
//   { key, op: "delete", user, id, createdAt, tried }
//     user  … 積んだ人。別の人の合言葉で登録し直した場合に、まちがって送らないため
//     tried … 1回でも送ろうとしたか(= 保存先に書かれているかもしれないか)
//
// 送り方
//   - 古い順に1件ずつ。成功したらキューから外す。
//   - 電波がない・保存先が混んでいる・ロック中(locked)などは、キューに残して止まる。
//     次の合図(起動・online・画面復帰・30秒後)で送り直す。
//   - 保存先は同じ id を二重に書かないので、何度送り直しても二重にならない。
//   - 送り直しても通らない失敗(invalid / forbidden)だけは、キューから外して知らせる。
//   - 保存先が古い版で、その操作をまだ知らない(unknown_action)ときは、その操作だけ後回しにして、
//     うしろの操作を先に送る(1件が詰まって、ふつうの入力まで送れなくなるのを防ぐ)。
//     後回しにした操作はキューに残り、しばらくして(または次に開いたとき)送り直す。

import { ApiError, addRecord, deleteRecord, updateRecord } from "./api.js";
import * as store from "./store.js";
import { toDateTimeString } from "./summary.js";
import { newId } from "./util.js";

const RETRY_MS = 30000;
/** 残しても通る見込みがないエラー */
const PERMANENT_ERRORS = ["invalid", "forbidden"];
/** 保存先が古い版で受けつけてもらえなかった操作を、つぎに送ってみるまでの間隔 */
const DEFER_MS = 5 * 60 * 1000;

const listeners = new Set();
let running = null; // 送信中の Promise(同時に2本走らせない)
let retryTimer = 0;
/** 後回しにしている操作(key → 後回しにした時刻)。アプリを開き直すと空になり、もういちど試す */
const deferred = new Map();

function isDeferred(op) {
  const at = deferred.get(op.key);
  if (at === undefined) return false;
  if (Date.now() - at >= DEFER_MS) {
    deferred.delete(op.key);
    return false;
  }
  return true;
}

/** 保存先が古い版のために、送れずに待っている操作があるか(自分の分) */
export function needsUpdate() {
  return mine(store.getQueue()).some((op) => deferred.has(op.key));
}

/**
 * キューの変化を受け取る。
 * @param {(event: {type: string, code?: string, op?: object}) => void} fn
 *   type: "change"(件数が変わった) / "sent" / "dropped"(送れずに外した) / "error"(残して中断)
 */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(event) {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch (err) {
      console.error(err);
    }
  }
}

function mine(queue) {
  const user = store.getUser();
  return queue.filter((op) => op.user === user);
}

/** 自分の未送信の件数 */
export function pendingCount() {
  return mine(store.getQueue()).length;
}

/** 自分の、まだ送れていない「追加」の記録(新しい順)。候補の表示などに使う */
export function pendingRecords() {
  return mine(store.getQueue())
    .filter((op) => op.op === "add")
    .map((op) => op.record)
    .reverse();
}

/** 自分の、まだ送れていない操作のすべて(古い順)。「見る」の集計に重ねるために使う */
export function pendingOps() {
  return mine(store.getQueue());
}

/** 自分の、まだ送れていない「取り消し」の id */
export function pendingDeleteIds() {
  return mine(store.getQueue())
    .filter((op) => op.op === "delete")
    .map((op) => op.id);
}

function removeByKey(key) {
  const queue = store.getQueue();
  const next = queue.filter((op) => op.key !== key);
  if (next.length !== queue.length) {
    store.setQueue(next);
  }
}

/**
 * 記録を1件キューに積んで、すぐ送りはじめる。
 * @returns {boolean} 端末に積めたか(false = localStorage に書けなかった)
 */
export function enqueueAdd(record) {
  const queue = store.getQueue();
  queue.push({ key: newId(), op: "add", user: store.getUser(), record, createdAt: Date.now(), tried: false });
  if (!store.setQueue(queue)) {
    return false;
  }
  emit({ type: "change" });
  flush();
  return true;
}

/**
 * 記録の修正を積んで、すぐ送りはじめる(「見る」の明細から)。
 *   - その記録の「追加」がまだ一度も送られていない → 追加の中身を差しかえるだけ
 *   - それ以外 → 「修正」をキューに積む(同じ記録の、まだ送っていない修正があれば置きかえる)
 * @returns {boolean} 端末に積めたか
 */
export function enqueueUpdate(record) {
  const queue = store.getQueue();
  const user = store.getUser();
  const isMine = (op, type) => op.op === type && op.user === user && op.record.id === record.id && !op.tried;
  const add = queue.find((op) => isMine(op, "add"));
  if (add) {
    add.record = { ...record };
  } else {
    const index = queue.findIndex((op) => isMine(op, "update"));
    if (index >= 0) {
      queue.splice(index, 1);
    }
    queue.push({ key: newId(), op: "update", user, record: { ...record }, createdAt: Date.now(), tried: false });
  }
  if (!store.setQueue(queue)) {
    return false;
  }
  emit({ type: "change" });
  flush();
  return true;
}

/**
 * 記録を取り消す。
 *   - まだ一度も送っていない → キューから外すだけ(通信なし)
 *   - 送った/送っている途中かもしれない → 「削除」をキューに積む(これも失敗したら送り直す)
 * @returns {"removed" | "queued" | "failed"}
 */
export function cancel(id) {
  // 消す記録への「修正」は、もう送らなくてよい
  const queue = store.getQueue().filter((op) => !(op.op === "update" && op.record.id === id));
  const index = queue.findIndex((op) => op.op === "add" && op.record.id === id);
  const wasTried = index >= 0 ? Boolean(queue[index].tried) : true;
  if (index >= 0) {
    queue.splice(index, 1);
  }
  if (wasTried) {
    // 保存先に無ければ何も起きず、あれば削除の印が付く
    queue.push({ key: newId(), op: "delete", user: store.getUser(), id, createdAt: Date.now(), tried: false });
  }
  if (!store.setQueue(queue)) {
    return "failed";
  }
  // 前回取得した一覧からも外す(候補に残らないように)
  store.setRecords(store.getRecords().filter((r) => r.id !== id));
  emit({ type: "change" });
  if (wasTried) {
    flush();
    return "queued";
  }
  return "removed";
}

/** たまっている分を送る。すでに送信中なら、その続きを待つ */
export function flush() {
  if (!running) {
    running = run().finally(() => {
      running = null;
    });
  }
  return running;
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    if (document.visibilityState === "visible") {
      flush();
    }
  }, RETRY_MS);
}

async function run() {
  clearTimeout(retryTimer);
  for (;;) {
    if (!store.getAikotoba() || !store.getUser()) return;

    const queue = store.getQueue();
    const waiting = mine(queue);
    // 後回しにしている操作は飛ばして、その次から送る
    const op = waiting.find((o) => !isDeferred(o));
    if (!op) {
      // 残りは、後回しの分だけ。キューから消えた操作の印は捨てて、あとでもういちど試す
      const keys = new Set(waiting.map((o) => o.key));
      for (const key of deferred.keys()) {
        if (!keys.has(key)) deferred.delete(key);
      }
      if (waiting.length > 0) scheduleRetry();
      return;
    }

    // 電波がないと分かっているときは、送ろうとしない(「送ろうとした」印も付けない。
    // 印が無いうちは、取り消しがキューから外すだけで済む)
    if (navigator.onLine === false) {
      emit({ type: "error", code: "network", op });
      scheduleRetry();
      return;
    }

    // 送る前に「送ろうとした」印を付けておく(送信中にアプリが閉じられても分かるように)
    if (!op.tried) {
      op.tried = true;
      store.setQueue(queue);
    }

    try {
      if (op.op === "add") {
        await addRecord(op.record);
        // 取り消されていなければ、前回取得した一覧にも足しておく
        if (store.getQueue().some((o) => o.key === op.key)) {
          const records = store.getRecords().filter((r) => r.id !== op.record.id);
          records.push({
            ...op.record,
            月: op.record["日付"].slice(0, 7),
            作成日時: toDateTimeString(op.createdAt || Date.now()),
            記録した人: op.user,
            元: "アプリ",
          });
          store.setRecords(records);
        }
      } else if (op.op === "update") {
        await updateRecord(op.record);
        // 前回取得した一覧も直しておく(そのあいだに消されていたら、何もしない)
        const month = op.record["日付"].slice(0, 7);
        store.setRecords(
          store.getRecords().map((r) => (r.id === op.record.id ? { ...r, ...op.record, 月: month } : r))
        );
      } else {
        await deleteRecord(op.id);
      }
      removeByKey(op.key);
      emit({ type: "sent", op });
      emit({ type: "change" });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "unknown";
      if (PERMANENT_ERRORS.includes(code)) {
        removeByKey(op.key);
        emit({ type: "dropped", code, op });
        emit({ type: "change" });
        continue;
      }
      if (code === "unknown_action") {
        // 保存先が古い版。この操作だけ後回しにして、うしろの操作を送る
        deferred.set(op.key, Date.now());
        emit({ type: "error", code, op });
        continue;
      }
      // 合言葉がちがう(auth)ときも、記録は残す。入れ直したあとで送られる
      emit({ type: "error", code, op });
      if (code !== "auth") {
        scheduleRetry();
      }
      return;
    }
  }
}
