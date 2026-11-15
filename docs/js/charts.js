// 「グラフ」画面(版 0.7.0 から)。
//
//   - いちばん上の切り替え「自分 / 共同口座」で、どの財布のグラフかを選ぶ(えらんだほうを、この iPhone が覚える)。
//     相手の財布は出さない(共同口座の「入金」の目印は2人分の合計。共同口座の動きなので、2人とも見える)。
//   - 月の切り替えは「見る」と同じ部品・同じ範囲(記録のある最古の月 〜 今月)。開くたびに今月から。
//   - カードは3つ:
//       a. 月ごとの推移   … 直近6か月の積み上げ棒(変動費・固定費・特別費)+ 収入(共同口座は入金)の目印。棒を押すと、その月へ
//       b. この月のうちわけ … 変動費のカテゴリ別のドーナツ(上位5つ+その他)。扇・凡例を押すと、まんなかに金額と割合
//       c. 使ったペース   … 変動費の日ごとの累計の折れ線。前の月を薄い線で重ねる。押した日までの金額を上に出す
//   - 集計は summary.js(chartTrend / chartBreakdown / chartPace)。ここは描くだけ。
//   - 端末に保存してある前回のデータ(store)に、まだ送れていない操作(queue)を重ねて描く(「見る」と同じ)。
//   - グラフは、ライブラリを使わず、その場で SVG を組み立てる。viewBox を「いまの幅(px)」で作るので、
//     文字は指定どおりの大きさ(11px 以上)で出る。幅が変わったら描き直す。
//   - 色は仕様書 7章のパレットだけ。色だけに頼らず、凡例の文字と金額でも分かるようにしてある。
//     鼻のピンク(濃)は、使いすぎ(収入・入金を超えた月)の注意にだけ使う。

import * as queue from "./queue.js";
import * as store from "./store.js";
import { CHART_SCOPE, addMonth, applyQueue, chartBreakdown, chartPace, chartTrend, monthRange } from "./summary.js";
import { formatAmount, todayString } from "./util.js";

// --- 色(app.css の :root と同じ値) ------------------------------------------

const C = Object.freeze({
  ink: "#2E2A28",
  gray: "#6B6560",
  amber: "#C39A3B",
  amberDark: "#8A6417",
  amberLight: "#F3DDAE",
  silver: "#B4B2B6",
  silverDark: "#8F8D92",
  pinkDark: "#8A4B3C",
  white: "#FFFFFF",
  bg: "#F4EFE8",
  grid: "#E8E0D5",
});

/** 積み上げ棒の段(下から順)。どの2つが隣り合っても見分けられる組み合わせ(固定費や特別費が 0 の月は、隣が変わるので) */
const STACK = Object.freeze([
  { key: "variable", name: "変動費", color: C.amber },
  { key: "fixed", name: "固定費", color: C.amberDark },
  { key: "special", name: "特別費", color: C.ink },
]);
/** 収入(共同口座は入金)の目印 */
const MARKER_COLOR = C.silverDark;

/** ドーナツの扇の色(金額の大きい順に、この順で使う)。輪の隣どうし(最後と最初も)が見分けられる並び */
const DONUT_COLORS = Object.freeze([C.amberDark, C.amber, C.ink, C.silverDark, C.amberLight, C.silver]);

const LINE = Object.freeze({
  loading: "さいしんのきろくを、よみこみ中にゃ…",
  loadFailed: "まだ読みこめていないにゃ。電波のよいところで、もういちど開いてみてね。",
  noMonth: "この月のきろくは、まだないにゃ。",
  noVariable: "この月の変動費は、まだないにゃ。",
});

const $ = (id) => document.getElementById(id);

const el = {
  view: $("view-charts"),
  scopes: Array.from(document.querySelectorAll("#chart-scopes .choice")),
  prev: $("chart-prev"),
  next: $("chart-next"),
  title: $("chart-title"),
  wait: $("chart-wait"),
  waitText: $("chart-wait-text"),
  cards: $("chart-cards"),
  // a. 月ごとの推移
  trendTotal: $("trend-total"),
  trendNone: $("trend-none"),
  trendPlot: $("trend-plot"),
  trendKeys: $("trend-keys"),
  trendOver: $("trend-over"),
  // b. この月のうちわけ
  donutEmpty: $("donut-empty"),
  donutEmptyText: $("donut-empty-text"),
  donut: $("donut"),
  donutPlot: $("donut-plot"),
  centerLabel: $("donut-center-label"),
  centerAmount: $("donut-center-amount"),
  centerPercent: $("donut-center-percent"),
  legend: $("donut-legend"),
  donutExtras: $("donut-extras"),
  // c. 使ったペース
  paceNone: $("pace-none"),
  paceBody: $("pace-body"),
  paceLabel: $("pace-label"),
  paceAmount: $("pace-amount"),
  paceCompare: $("pace-compare"),
  pacePlot: $("pace-plot"),
  paceKeys: $("pace-keys"),
};

/** 画面の部品がそろっているか。版が入れ替わる途中で、前の版の HTML のままこの JS が動いたときは、なにもしない */
const ready = Object.values(el).every((n) => (Array.isArray(n) ? n.length > 0 : Boolean(n)));

const state = {
  user: "",
  scope: CHART_SCOPE.SELF, // "self" | "joint"
  month: "",               // 見ている月 'YYYY-MM'
  sync: "idle",            // 裏での取得: "idle" | "loading" | "ok" | "error"
  pick: "",                // ドーナツで押したカテゴリの名前(なければ空)
  paceDay: 0,              // 折れ線で押した日(0 = 押していない → 線の最後の日)
  width: 0,                // いま描いてある幅
  breakdown: null,         // いま描いてある集計(押したときに、そこだけ描き直す)
  pace: null,
  paceGeo: null,           // 折れ線の位置の計算(押した場所 → 日にち)
};

// --- 小さな道具 -------------------------------------------------------------

function yen(amount) {
  return amount < 0 ? `-¥${formatAmount(-amount)}` : `¥${formatAmount(amount)}`;
}

/** 棒の下に出す、短い金額: 123400 → '12.3万' / 1234000 → '123万' / 800 → '800円' / 0 → '0円' */
function shortMan(amount) {
  if (amount < 1000) return `${amount}円`;
  if (amount >= 1000000) return `${Math.round(amount / 10000)}万`;
  return `${Number((amount / 10000).toFixed(1))}万`;
}

/** 目盛りの金額: 0 / 5,000 / 2万 / 2.5万 */
function axisLabel(amount) {
  if (amount === 0) return "0";
  if (amount >= 10000) return `${Number((amount / 10000).toFixed(2))}万`;
  return formatAmount(amount);
}

function monthTitle(month) {
  const [y, m] = month.split("-").map(Number);
  return `${y}年${m}月`;
}

function monthName(month) {
  return `${Number(month.split("-")[1])}月`;
}

function scopeName() {
  return state.scope === CHART_SCOPE.JOINT ? "共同口座" : `${state.user}の財布`;
}

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** SVG の部品を1つ作る */
function s(tag, attrs, text) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs || {})) n.setAttribute(key, String(value));
  if (text !== undefined) n.textContent = text;
  return n;
}

/** 小数1けたに丸める(SVG の座標を短く) */
function r1(n) {
  return Math.round(n * 10) / 10;
}

/** 目盛りの上限と刻み(線は 2〜4 本)。きりのいい数字にする */
function niceScale(max) {
  if (!(max > 0)) return { top: 1, step: 1 };
  const pow = 10 ** Math.floor(Math.log10(max / 3));
  let step = pow * 10;
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (Math.ceil(max / (m * pow)) <= 4) {
      step = m * pow;
      break;
    }
  }
  step = Math.max(1, Math.round(step));
  return { top: Math.ceil(max / step) * step, step };
}

function isShown() {
  return ready && !el.view.hidden;
}

/** グラフを入れる枠の幅(px)。まだ測れないときは、ふつうの iPhone の幅で */
function plotWidth() {
  const w = Math.floor(el.trendPlot.clientWidth || el.pacePlot.clientWidth || el.cards.clientWidth - 32);
  return w > 120 ? w : 318;
}

function newSvg(width, height, label) {
  const svg = s("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": label });
  svg.setAttribute("class", "chart__svg");
  return svg;
}

/** 横の目盛り線と、左の金額 */
function drawGrid(svg, { left, right, y, top, step }) {
  for (let v = 0; v <= top + step / 2; v += step) {
    const yy = r1(y(v));
    svg.append(s("line", { x1: left, x2: right, y1: yy, y2: yy, stroke: v === 0 ? "#CFC4B6" : C.grid, "stroke-width": 1 }));
    svg.append(s("text", { x: left - 6, y: yy + 4, "text-anchor": "end", class: "cx-axis" }, axisLabel(v)));
  }
}

// --- a. 月ごとの推移(積み上げ棒) -------------------------------------------

const GAP = 2; // 段と段のあいだの、白いすきま(px)

function trendLabel(trend) {
  const markerName = trend.markerKind === "deposit" ? "入金" : "収入";
  const parts = trend.months.map((m) => {
    const inner = STACK.map((seg) => `${seg.name} ${formatAmount(m[seg.key])}円`);
    if (m.marker > 0) inner.push(`${markerName} ${formatAmount(m.marker)}円`);
    return `${monthName(m.month)} 合計 ${formatAmount(m.total)}円（${inner.join("、")}）`;
  });
  return `${scopeName()}の、月ごとの支出。${parts.join("。")}。`;
}

function renderTrend(trend, W) {
  const selected = trend.months.find((m) => m.month === state.month) || {
    month: state.month, variable: 0, fixed: 0, special: 0, total: 0, marker: 0, over: false,
  };
  const markerName = trend.markerKind === "deposit" ? "入金" : "収入"; // 入金 = 2人の「共同へ入金」の合計 / 収入 = 確定した手取り

  // 見出しの右: 選んでいる月の合計
  el.trendTotal.textContent = "";
  el.trendTotal.append(node("span", "chart__total-label", `${monthName(selected.month)}の合計`), document.createTextNode(yen(selected.total)));

  // 凡例(選んでいる月の金額つき)。色だけでなく、名前と金額で読める
  el.trendKeys.textContent = "";
  for (const seg of STACK) {
    el.trendKeys.append(keyItem(seg.color, seg.name, yen(selected[seg.key]), false));
  }
  const noMarker = trend.markerKind === "deposit" ? "まだなし" : "未確定";
  el.trendKeys.append(keyItem(MARKER_COLOR, markerName, selected.marker > 0 ? yen(selected.marker) : noMarker, true));

  // 使いすぎの注意(色だけにせず、文でも出す)
  el.trendOver.hidden = !selected.over;
  if (selected.over) {
    el.trendOver.textContent = `${monthName(selected.month)}は、${trend.markerKind === "deposit" ? "入金" : "収入"}より ${yen(
      selected.total - selected.marker
    )} 多くつかっています`;
  }

  const any = trend.max > 0;
  el.trendNone.hidden = any;
  el.trendPlot.hidden = !any;
  el.trendPlot.textContent = "";
  if (!any) return;

  const H = 198;
  const pad = { left: 36, right: 2, top: 10, bottom: 44 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const { top, step } = niceScale(trend.max);
  const y = (v) => pad.top + plotH * (1 - v / top);
  const n = trend.months.length;
  const slotW = plotW / Math.max(n, 4);
  const x0 = pad.left + (plotW - n * slotW) / 2;
  const barW = Math.min(24, Math.round(slotW * 0.56));

  const svg = newSvg(W, H, trendLabel(trend));

  // 選んでいる月の帯(棒の後ろ)
  trend.months.forEach((m, i) => {
    if (m.month !== state.month) return;
    svg.append(s("rect", { x: r1(x0 + i * slotW + 1), y: 1, width: r1(slotW - 2), height: H - 2, rx: 10, fill: C.bg }));
  });

  drawGrid(svg, { left: pad.left, right: W - pad.right, y, top, step });

  trend.months.forEach((m, i) => {
    const cx = x0 + (i + 0.5) * slotW;
    const isSelected = m.month === state.month;
    const group = s("g", { class: "cx-bar" });

    // 段(下から: 変動費 → 固定費 → 特別費)。段のあいだは白いすきま。いちばん上の段だけ、上の角を丸める
    const segs = [];
    let acc = 0;
    for (const seg of STACK) {
      const v = m[seg.key];
      if (v <= 0) continue;
      segs.push({ color: seg.color, bottom: y(acc), top: y(acc + v) });
      acc += v;
    }
    segs.forEach((seg, k) => {
      const bottom = seg.bottom - (k > 0 ? GAP : 0);
      const topY = Math.min(seg.top, bottom - 1.5); // 小さすぎる段も、線としては見えるように
      const h = bottom - topY;
      const left = cx - barW / 2;
      if (k === segs.length - 1) {
        const rad = Math.min(4, h, barW / 2);
        group.append(
          s("path", {
            d: `M${r1(left)} ${r1(bottom)}V${r1(topY + rad)}Q${r1(left)} ${r1(topY)} ${r1(left + rad)} ${r1(topY)}H${r1(
              left + barW - rad
            )}Q${r1(left + barW)} ${r1(topY)} ${r1(left + barW)} ${r1(topY + rad)}V${r1(bottom)}Z`,
            fill: seg.color,
          })
        );
      } else {
        group.append(s("rect", { x: r1(left), y: r1(topY), width: barW, height: r1(h), fill: seg.color }));
      }
    });

    // 目印(収入・入金): 棒より少し長い横線と、まんなかの白ぬきの点。白いふちで、棒に重なっても見える
    if (m.marker > 0) {
      const my = r1(y(m.marker));
      const half = barW / 2 + 7;
      group.append(s("line", { x1: r1(cx - half), x2: r1(cx + half), y1: my, y2: my, stroke: C.white, "stroke-width": 6, "stroke-linecap": "round" }));
      group.append(s("line", { x1: r1(cx - half), x2: r1(cx + half), y1: my, y2: my, stroke: MARKER_COLOR, "stroke-width": 2, "stroke-linecap": "round" }));
      group.append(s("circle", { cx: r1(cx), cy: my, r: 3.5, fill: C.white, stroke: MARKER_COLOR, "stroke-width": 2 }));
    }
    svg.append(group);

    // 月と、合計(短い書き方)
    svg.append(s("text", { x: r1(cx), y: H - pad.bottom + 17, "text-anchor": "middle", class: isSelected ? "cx-month cx-month--on" : "cx-month" }, monthName(m.month)));
    const totalClass = ["cx-total", isSelected ? "cx-total--on" : "", m.over ? "cx-total--over" : ""].filter(Boolean).join(" ");
    svg.append(s("text", { x: r1(cx), y: H - pad.bottom + 33, "text-anchor": "middle", class: totalClass }, shortMan(m.total)));

    // 押せる範囲は、棒だけでなく、その月の列ぜんぶ
    const hit = s("rect", { x: r1(x0 + i * slotW), y: 0, width: r1(slotW), height: H, fill: "transparent", class: "cx-hit" });
    hit.dataset.month = m.month;
    svg.append(hit);
  });

  el.trendPlot.append(svg);
}

/** 凡例の1つ(色の印 + 名前 + 金額)。line = 線の印(目印・折れ線) */
function keyItem(color, name, amount, line) {
  const li = node("li", "key");
  const swatch = node("span", line ? "key__swatch key__swatch--line" : "key__swatch");
  swatch.style.background = color;
  li.append(swatch, node("span", "key__name", name));
  if (amount !== undefined) li.append(node("span", "key__amount", amount));
  return li;
}

// --- b. この月のうちわけ(ドーナツ) -----------------------------------------

const DONUT = Object.freeze({ size: 184, outer: 84, inner: 58, grow: 4 });

function polar(radius, angle) {
  const c = DONUT.size / 2;
  return `${r1(c + radius * Math.cos(angle))} ${r1(c + radius * Math.sin(angle))}`;
}

/** 扇の形(a0〜a1 は、真上から時計まわりの角度)。となりとのあいだに、同じ幅の白いすきまを空ける */
function slicePath(a0, a1, outer, inner) {
  const span = a1 - a0;
  let padOuter = Math.asin(GAP / 2 / outer);
  let padInner = Math.asin(GAP / 2 / inner);
  if (span < padInner * 2 + 0.02) {
    // とても細い扇: すきまを取ると消えてしまうので、すきまを細くする
    padOuter = span * 0.15;
    padInner = span * 0.15;
  }
  const o0 = a0 + padOuter - Math.PI / 2;
  const o1 = a1 - padOuter - Math.PI / 2;
  const i0 = a0 + padInner - Math.PI / 2;
  const i1 = a1 - padInner - Math.PI / 2;
  const large = o1 - o0 > Math.PI ? 1 : 0;
  const largeInner = i1 - i0 > Math.PI ? 1 : 0;
  return `M${polar(outer, o0)}A${outer} ${outer} 0 ${large} 1 ${polar(outer, o1)}L${polar(inner, i1)}A${inner} ${inner} 0 ${largeInner} 0 ${polar(inner, i0)}Z`;
}

function sliceName(slice) {
  return slice.other ? `${slice.name}（${slice.count}つ）` : slice.name;
}

function donutLabel(b) {
  const parts = b.slices.map((sl) => `${sliceName(sl)} ${formatAmount(sl.amount)}円（${sl.percent}%）`);
  return `${scopeName()}の、${monthName(b.month)}の変動費うちわけ。合計 ${formatAmount(b.total)}円。${parts.join("、")}。`;
}

function renderDonut(b) {
  state.breakdown = b;
  const has = b.total > 0;
  el.donutEmpty.hidden = has;
  el.donut.hidden = !has;
  el.legend.hidden = !has;
  el.donutEmptyText.textContent = b.spend > 0 ? LINE.noVariable : LINE.noMonth;

  // 固定費・特別費は、ドーナツに混ぜず、下に小さく添える
  el.donutExtras.textContent = "";
  for (const [name, amount] of [["固定費", b.fixed], ["特別費", b.special]]) {
    if (!(amount > 0)) continue;
    const row = node("div", "extra");
    const left = node("span", "extra__left");
    left.append(node("span", "tag", name));
    row.append(left, node("span", "extra__amount", yen(amount)));
    el.donutExtras.append(row);
  }
  if (el.donutExtras.children.length > 0) el.donutExtras.prepend(node("div", "extra__note", "ドーナツに入れていないもの"));
  el.donutExtras.hidden = el.donutExtras.children.length === 0;

  el.donutPlot.textContent = "";
  el.legend.textContent = "";
  if (!has) return;

  if (!b.slices.some((sl) => sl.name === state.pick)) state.pick = "";
  const picked = b.slices.find((sl) => sl.name === state.pick) || null;

  const svg = newSvg(DONUT.size, DONUT.size, donutLabel(b));
  svg.setAttribute("width", DONUT.size);
  svg.setAttribute("height", DONUT.size);
  let angle = 0;
  b.slices.forEach((slice, i) => {
    const color = DONUT_COLORS[i % DONUT_COLORS.length];
    const span = (slice.amount / b.total) * Math.PI * 2;
    const isPicked = picked === slice;
    const outer = DONUT.outer + (isPicked ? DONUT.grow : 0);
    let shape;
    if (b.slices.length === 1) {
      // 1つだけ(100%): 切れ目のない輪
      const mid = (outer + DONUT.inner) / 2;
      shape = s("circle", { cx: DONUT.size / 2, cy: DONUT.size / 2, r: mid, fill: "none", stroke: color, "stroke-width": outer - DONUT.inner });
    } else {
      shape = s("path", { d: slicePath(angle, angle + span, outer, DONUT.inner), fill: color });
    }
    shape.setAttribute("class", "cx-slice");
    if (picked && !isPicked) shape.setAttribute("opacity", "0.35");
    shape.dataset.slice = slice.name;
    svg.append(shape);
    angle += span;

    // 凡例: 色の印・カテゴリ名・割合・金額。押すと、その扇を選ぶ(細い扇は、ここから押せる)
    const li = node("li");
    const row = node("button", "legend__row");
    row.type = "button";
    row.dataset.slice = slice.name;
    row.setAttribute("aria-pressed", isPicked ? "true" : "false");
    const swatch = node("span", "legend__swatch");
    swatch.style.background = color;
    row.append(swatch, node("span", "legend__name", sliceName(slice)), node("span", "legend__percent", `${slice.percent}%`), node("span", "legend__amount", yen(slice.amount)));
    li.append(row);
    el.legend.append(li);
  });
  el.donutPlot.append(svg);

  // まんなか: ふだんは合計。押したら、そのカテゴリ
  el.centerLabel.textContent = picked ? sliceName(picked) : "変動費の合計";
  el.centerAmount.textContent = yen(picked ? picked.amount : b.total);
  el.centerPercent.textContent = picked ? `${picked.percent}%` : "";
  el.centerPercent.hidden = !picked;
}

function pickSlice(name) {
  state.pick = state.pick === name ? "" : name;
  if (state.breakdown) renderDonut(state.breakdown);
}

// --- c. 使ったペース(折れ線) -----------------------------------------------

function linePath(points) {
  return points.map(([px, py], i) => `${i === 0 ? "M" : "L"}${r1(px)} ${r1(py)}`).join("");
}

function paceLabel(p) {
  const m = monthName(p.month);
  let text = `${scopeName()}の、${m}の変動費の累計。${p.lastDay}日まで ${formatAmount(p.toDate)}円。`;
  if (p.prev) {
    const pm = monthName(p.prev.month);
    text += `${pm}の同じ日まで ${formatAmount(p.prev.sameDay)}円、${pm}の月末まで ${formatAmount(p.prev.total)}円。`;
  }
  return text;
}

function renderPace(p, W) {
  state.pace = p;
  state.paceGeo = null;
  const has = p.total > 0;
  el.paceNone.hidden = has;
  el.paceNone.textContent = LINE.noVariable;
  el.paceBody.hidden = !has;
  el.pacePlot.textContent = "";
  el.paceKeys.textContent = "";
  if (!has) return;

  const H = 190;
  const pad = { left: 36, right: 12, top: 26, bottom: 24 }; // 上は、金額のラベルが入る分を空けておく
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const days = Math.max(p.days, p.prev ? p.prev.days : 0);
  const { top, step } = niceScale(Math.max(p.toDate, p.prev ? p.prev.total : 0));
  const x = (d) => pad.left + (plotW * (d - 1)) / (days - 1);
  const y = (v) => pad.top + plotH * (1 - v / top);

  const svg = newSvg(W, H, paceLabel(p));
  drawGrid(svg, { left: pad.left, right: W - pad.right, y, top, step });

  // 横の目盛り: 1日・10日・20日・月末
  const baseline = y(0);
  for (const d of [1, 10, 20, days]) {
    const anchor = d === 1 ? "start" : d === days ? "end" : "middle";
    svg.append(s("text", { x: r1(x(d)), y: H - 6, "text-anchor": anchor, class: "cx-axis" }, `${d}日`));
  }

  // 前の月(薄い線)。月末まで
  if (p.prev) {
    svg.append(
      s("path", {
        d: linePath(p.prev.daily.map((v, i) => [x(i + 1), y(v)])),
        fill: "none", stroke: C.silver, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round",
      })
    );
  }

  // この月: 線の最後の日(今月なら、きょう)まで。下を、うすく塗る
  const points = p.daily.slice(0, p.lastDay).map((v, i) => [x(i + 1), y(v)]);
  if (points.length > 1) {
    svg.append(s("path", { d: `${linePath(points)}V${r1(baseline)}H${r1(points[0][0])}Z`, fill: C.amberLight, opacity: 0.45 }));
    svg.append(
      s("path", { d: linePath(points), fill: "none", stroke: C.ink, "stroke-width": 2.5, "stroke-linejoin": "round", "stroke-linecap": "round" })
    );
  }

  // 押した日(なければ、線の最後の日)の印。押すたびに、ここだけ入れ替える
  const pickLayer = s("g", { class: "cx-pick" });
  svg.append(pickLayer);
  el.pacePlot.append(svg);

  // 凡例(線が2本のときだけ。1本なら、見出しで足りる)
  if (p.prev) {
    el.paceKeys.append(keyItem(C.ink, monthName(p.month), undefined, true), keyItem(C.silver, `${monthName(p.prev.month)}（前の月）`, undefined, true));
  }
  el.paceKeys.hidden = !p.prev;

  state.paceGeo = { svg, pickLayer, W, H, pad, plotW, days, x, y, baseline };
  if (state.paceDay > p.lastDay) state.paceDay = 0;
  updatePacePick();
}

/** 折れ線の、押した日の印と、上の「その日までの金額」を出しなおす */
function updatePacePick() {
  const p = state.pace;
  const geo = state.paceGeo;
  if (!p || !geo) return;
  const day = state.paceDay || p.lastDay;
  const amount = p.daily[day - 1];
  const m = monthName(p.month);
  const today = todayString();
  const isToday = p.isCurrent && day === Number(today.slice(8, 10));

  // 上の数字
  el.paceLabel.textContent = `${m}${day}日${isToday ? "（きょう）" : day === p.days ? "（月末）" : ""}まで`;
  el.paceAmount.textContent = yen(amount);
  el.paceCompare.textContent = "";
  let before = null;
  if (p.prev) {
    const pm = monthName(p.prev.month);
    const prevDay = Math.min(day, p.prev.days);
    before = p.prev.daily[prevDay - 1];
    const diff = amount - before;
    const sameDay = prevDay < day ? `${pm}の月末まで` : `${pm}の同じ日まで`; // 前の月のほうが短いとき
    el.paceCompare.append(document.createTextNode(`${sameDay} `), node("b", "", yen(before)));
    el.paceCompare.append(
      document.createTextNode(diff > 0 ? `（${yen(diff)} 多い）` : diff < 0 ? `（${yen(-diff)} 少ない）` : "（おなじ）")
    );
  } else {
    el.paceCompare.textContent = "前の月の記録は、ありません";
  }

  // 印: たての細い線、前の月の点、この月の点、金額
  const layer = geo.pickLayer;
  layer.textContent = "";
  const px = geo.x(day);
  const py = geo.y(amount);
  if (state.paceDay) {
    layer.append(s("line", { x1: r1(px), x2: r1(px), y1: geo.pad.top - 4, y2: r1(geo.baseline), stroke: C.silverDark, "stroke-width": 1 }));
  }
  if (before !== null && state.paceDay) {
    const prevDay = Math.min(day, p.prev.days);
    layer.append(s("circle", { cx: r1(geo.x(prevDay)), cy: r1(geo.y(before)), r: 4, fill: C.silver, stroke: C.white, "stroke-width": 2 }));
  }
  layer.append(s("circle", { cx: r1(px), cy: r1(py), r: 5, fill: C.ink, stroke: C.white, "stroke-width": 2 }));

  // 金額のラベル(白いふち付き)。はみ出さないように、左右と上下を寄せる
  const text = yen(amount);
  const half = (text.length * 7.6) / 2;
  const tx = Math.min(geo.W - 2 - half, Math.max(geo.pad.left + 2 + half, px));
  const ty = py - 12;
  layer.append(s("text", { x: r1(tx), y: r1(ty), "text-anchor": "middle", class: "cx-value" }, text));
}

/** 折れ線を押した・なぞった場所から、日にちを決める(線のある日まで) */
function pickPaceDay(event) {
  const p = state.pace;
  const geo = state.paceGeo;
  if (!p || !geo) return;
  const box = geo.svg.getBoundingClientRect();
  if (!(box.width > 0)) return;
  const px = ((event.clientX - box.left) * geo.W) / box.width;
  const raw = Math.round(((px - geo.pad.left) / geo.plotW) * (geo.days - 1)) + 1;
  const day = Math.min(p.lastDay, Math.max(1, raw));
  if (day === state.paceDay) return;
  state.paceDay = day;
  updatePacePick();
}

// --- 画面全体 ---------------------------------------------------------------

function resetPicks() {
  state.pick = "";
  state.paceDay = 0;
}

function render() {
  if (!ready) return;
  const user = store.getUser();
  if (!user) return;
  const today = todayString();
  const thisMonth = today.slice(0, 7);
  if (state.user !== user) {
    // 持ち主が変わった(登録し直した)ら、最初の状態に戻す
    state.user = user;
    state.month = thisMonth;
    state.scope = store.getChartScope();
    resetPicks();
  }

  // 切り替え(入力画面と同じく、「自分」は名前で出す)
  for (const button of el.scopes) {
    if (button.dataset.scope === CHART_SCOPE.SELF) button.textContent = user;
    button.setAttribute("aria-pressed", button.dataset.scope === state.scope ? "true" : "false");
  }

  const { records } = applyQueue(store.getRecords(), queue.pendingOps(), user);
  const range = monthRange(records, user, thisMonth);
  if (!state.month || state.month < range.min) state.month = range.min;
  if (state.month > range.max) state.month = range.max;
  el.title.textContent = monthTitle(state.month);
  el.prev.disabled = state.month <= range.min;
  el.next.disabled = state.month >= range.max;

  // 読み込み前(まだ一度も取れていない)
  const neverLoaded = records.length === 0 && !store.getSyncedAt();
  const waiting = neverLoaded && state.sync !== "ok";
  el.wait.hidden = !waiting;
  el.waitText.textContent = waiting ? (state.sync === "error" ? LINE.loadFailed : LINE.loading) : "";
  el.cards.hidden = waiting;
  if (waiting) return;

  const W = plotWidth();
  state.width = W;
  renderTrend(chartTrend(records, user, state.scope, { selected: state.month, thisMonth }), W);
  renderDonut(chartBreakdown(records, user, state.scope, state.month));
  renderPace(chartPace(records, user, state.scope, state.month, today), W);
}

function selectMonth(month) {
  if (!month || month === state.month) return;
  state.month = month;
  resetPicks();
  render();
}

function selectScope(scope) {
  const next = scope === CHART_SCOPE.JOINT ? CHART_SCOPE.JOINT : CHART_SCOPE.SELF;
  if (next === state.scope) return;
  state.scope = next;
  store.setChartScope(next);
  resetPicks();
  render();
}

// --- 外から呼ぶもの ---------------------------------------------------------

/** 「グラフ」のタブを開いたとき: いつも今月から(切り替えは、前回えらんだほう) */
export function showCharts() {
  if (!ready) return;
  state.month = todayString().slice(0, 7);
  state.scope = store.getChartScope();
  resetPicks();
  render();
}

/** 保存先から新しいデータが届いた・キューが変わったとき: 出ていれば出しなおす */
export function refreshCharts() {
  if (isShown()) render();
}

/** 裏での取得のようす(app.js から)。読み込み前の表示に使う */
export function setChartsSyncState(value) {
  const before = state.sync;
  state.sync = value;
  // 読み込み前の一言を出しているあいだだけ、出しなおす(ふだんは、データが届いたときに refreshCharts が呼ばれる)
  if (isShown() && before !== value && !el.wait.hidden) render();
}

export function initCharts() {
  if (!ready) return;
  for (const button of el.scopes) {
    button.addEventListener("click", () => selectScope(button.dataset.scope));
  }
  el.prev.addEventListener("click", () => selectMonth(addMonth(state.month, -1)));
  el.next.addEventListener("click", () => selectMonth(addMonth(state.month, 1)));

  // 棒(その月の列)を押す → その月に切り替える
  el.trendPlot.addEventListener("click", (event) => {
    const hit = event.target.closest("[data-month]");
    if (hit) selectMonth(hit.dataset.month);
  });

  // ドーナツの扇・凡例を押す → まんなかに、そのカテゴリの金額と割合(もういちど押すと、合計に戻る)
  el.donutPlot.addEventListener("click", (event) => {
    const slice = event.target.closest("[data-slice]");
    if (slice) pickSlice(slice.dataset.slice);
    else if (state.pick) pickSlice(state.pick);
  });
  el.legend.addEventListener("click", (event) => {
    const row = event.target.closest("[data-slice]");
    if (row) pickSlice(row.dataset.slice);
  });

  // 折れ線を押す・なぞる → その日までの金額(たてのスクロールは、じゃましない: CSS の touch-action: pan-y)
  el.pacePlot.addEventListener("pointerdown", pickPaceDay);
  el.pacePlot.addEventListener("pointermove", (event) => {
    if (event.pointerType === "mouse" || event.buttons > 0 || event.pressure > 0) pickPaceDay(event);
  });

  // 幅が変わったら(画面の向き・パソコンの窓)、その幅で描き直す
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => {
      if (isShown() && !el.cards.hidden && plotWidth() !== state.width) render();
    }).observe(el.cards);
  }

  queue.subscribe((event) => {
    if (event.type === "change") refreshCharts();
  });
}
