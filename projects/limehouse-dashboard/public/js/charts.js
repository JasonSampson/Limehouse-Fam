// Chart helpers shared by dashboard.js, ceo-view.js, team-performance.js.
// Wraps Chart.js (vendored locally at /js/vendor/chart.umd.min.js — no CDN
// dependency at runtime, consistent with this project's no-build-step,
// works-offline architecture). Chart.js was chosen because the visual
// parity spec calls for several genuinely different chart types
// (sparklines, grouped bars, multi-series line, donut/ring) and hand-rolling
// all of that in raw SVG would be a lot of fragile math for a small
// internal tool — one ~200KB vendored file is simpler to maintain than a
// custom charting layer, and stays within "plain HTML/CSS/vanilla JS,
// no bundler."

const LH_COLORS = {
  green: "#1e5631",
  greenLight: "#4a8f5c",
  amber: "#c8791e",
  amberLight: "#e8b567",
  red: "#c23b3b",
  blue: "#2f6fb0",
  purple: "#7a52a0",
  gray: "#8b93a1",
  grayDark: "#4b5563",
  navy: "#1c2b3a",
};

// Fixed-order categorical palette for the CEO View year-over-year charts —
// ADDED 2026-07-26, per Jason directly: every past year used to render in
// the exact same gray, indistinguishable from every other past year. This
// is Anthropic's dataviz-skill reference palette (validated: worst
// adjacent CVD ΔE 24.2 under protanopia/deuteranopia, well clear of the
// >=12 target) — 8 fixed hues, assigned in order, never cycled.
const YEAR_CHART_PAST_COLORS = ["#2a78d6", "#1baf7a", "#eda100", "#008300", "#4a3aa7", "#e34948", "#e87ba4", "#eb6834"];

// Assigns each year a stable color: the current year always gets
// LH_COLORS.green (per Jason directly, replacing the earlier blue), and
// past years get the 8-hue palette above in oldest-to-newest order. Only
// the most recent 8 PAST years are ever shown — per Jason directly
// ("we need more colors as the years go by"), rather than ever inventing
// a 9th categorical hue (the dataviz skill's own rule: a 9th series folds
// into a bounded window, not a generated color). As a new year becomes
// current, the oldest past year rolls off the chart instead of the
// palette running out.
function assignYearColors(years, currentYear) {
  const pastYears = years.filter((y) => String(y) !== String(currentYear)).sort();
  const recentPastYears = pastYears.slice(-YEAR_CHART_PAST_COLORS.length);
  const colorByYear = new Map();
  recentPastYears.forEach((y, i) => colorByYear.set(String(y), YEAR_CHART_PAST_COLORS[i]));
  colorByYear.set(String(currentYear), LH_COLORS.green);
  return { colorByYear, visibleYears: [...recentPastYears, String(currentYear)] };
}

// Category color assignment for Property Health and similar "arbitrary
// list of named categories" charts. Falls back to a rotating palette for
// any category name we don't have a specific brand color for, so a new
// category (e.g. an "Unknown" bucket Q adds later) still renders sensibly
// instead of breaking.
const CATEGORY_COLOR_MAP = {
  healthy: LH_COLORS.green,
  "at-risk": LH_COLORS.amber,
  "at risk": LH_COLORS.amber,
  waitlist: LH_COLORS.purple,
  "on hold": LH_COLORS.blue,
  "off-market": LH_COLORS.gray,
  "off market": LH_COLORS.gray,
  commercial: LH_COLORS.grayDark,
  unknown: "#c7cbd1",
};
const FALLBACK_PALETTE = [LH_COLORS.blue, LH_COLORS.purple, LH_COLORS.amber, LH_COLORS.gray, LH_COLORS.greenLight];

function colorForCategory(name, fallbackIndex) {
  const key = String(name || "").trim().toLowerCase();
  if (CATEGORY_COLOR_MAP[key]) return CATEGORY_COLOR_MAP[key];
  return FALLBACK_PALETTE[fallbackIndex % FALLBACK_PALETTE.length];
}

// Keep a registry of chart instances by canvas id so re-rendering a tab
// (e.g. after a period change) destroys the old chart before creating a
// new one — Chart.js throws/leaks if you construct a second chart on a
// canvas that already has one attached.
const _chartRegistry = new Map();

function _makeChart(canvasId, config) {
  const existing = _chartRegistry.get(canvasId);
  if (existing) {
    existing.destroy();
    _chartRegistry.delete(canvasId);
  }
  const canvas = document.getElementById(canvasId);
  if (!canvas || typeof Chart === "undefined") return null;
  const chart = new Chart(canvas.getContext("2d"), config);
  _chartRegistry.set(canvasId, chart);
  return chart;
}

let _sparkCounter = 0;
function nextSparklineId() {
  _sparkCounter += 1;
  return `spark-${_sparkCounter}-${Date.now().toString(36)}`;
}

// ---------------------------------------------------------------------
// Sparkline: tiny inline trend line under a tile number. No axes/labels,
// just a colored line with a dot at the end.
// ---------------------------------------------------------------------
function sparklineHtml(values, color) {
  if (!values || values.length < 2) return "";
  const id = nextSparklineId();
  queueMicrotask(() => renderSparkline(id, values, color));
  return `<div class="tile-sparkline"><canvas id="${id}"></canvas></div>`;
}

function renderSparkline(canvasId, values, color) {
  _makeChart(canvasId, {
    type: "line",
    data: {
      labels: values.map((_, i) => i),
      datasets: [
        {
          data: values,
          borderColor: color,
          backgroundColor: color,
          borderWidth: 2,
          pointRadius: (ctx) => (ctx.dataIndex === values.length - 1 ? 3 : 0),
          pointBackgroundColor: color,
          tension: 0.35,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: { display: false },
        y: { display: false },
      },
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
      },
      elements: { line: { borderJoinStyle: "round" } },
    },
  });
}

// ---------------------------------------------------------------------
// Grouped bar chart (Rent Collection — 12 months: By 3rd / By 10th)
// ---------------------------------------------------------------------
function groupedBarChartHtml({ canvasId, labels, series, yFormat }) {
  queueMicrotask(() => renderGroupedBarChart({ canvasId, labels, series, yFormat }));
  return `<div class="chart-canvas-wrap" style="height:220px;"><canvas id="${canvasId}"></canvas></div>`;
}

function renderGroupedBarChart({ canvasId, labels, series, yFormat }) {
  _makeChart(canvasId, {
    type: "bar",
    data: {
      labels,
      datasets: series.map((s) => ({
        label: s.label,
        data: s.data,
        backgroundColor: s.color,
        borderRadius: 3,
        maxBarThickness: 16,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: yFormat ? { label: (ctx) => `${ctx.dataset.label}: ${yFormat(ctx.parsed.y)}` } : undefined,
        },
      },
      scales: {
        x: { grid: { display: false } },
        y: {
          beginAtZero: true,
          ticks: yFormat ? { callback: (v) => yFormat(v) } : undefined,
        },
      },
    },
  });
}

// ---------------------------------------------------------------------
// Multi-series line chart, one line per year, same Jan-Dec x-axis
// (CEO View: Gross Income / Net Income / Revenue Per Unit).
// ---------------------------------------------------------------------
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function yearOverYearLineChartHtml({ canvasId, seriesByYear, currentYear, yFormat }) {
  queueMicrotask(() => renderYearOverYearLineChart({ canvasId, seriesByYear, currentYear, yFormat }));
  const { colorByYear, visibleYears } = assignYearColors(Object.keys(seriesByYear), currentYear);
  return `
    <div class="chart-legend" style="margin-bottom:8px;">
      ${visibleYears
        .map((y) => `<span><span class="chart-legend-swatch" style="background:${colorByYear.get(y)};"></span>${y}</span>`)
        .join("")}
    </div>
    <div class="chart-canvas-wrap" style="height:240px;"><canvas id="${canvasId}"></canvas></div>
  `;
}

function renderYearOverYearLineChart({ canvasId, seriesByYear, currentYear, yFormat }) {
  const { colorByYear, visibleYears } = assignYearColors(Object.keys(seriesByYear), currentYear);
  const datasets = visibleYears.map((year) => {
    const isCurrent = String(year) === String(currentYear);
    const color = colorByYear.get(year);
    return {
      label: String(year),
      data: seriesByYear[year],
      borderColor: color,
      backgroundColor: color,
      borderWidth: isCurrent ? 3 : 1.5,
      pointRadius: isCurrent ? 2 : 0,
      // pointHoverRadius — ADDED 2026-07-26, per Jason directly, against a
      // real vendor screenshot: hovering a month shows a marker on every
      // year's line at that column, not just the current year's. Points
      // stay invisible otherwise (pointRadius above), only appearing on
      // hover.
      pointHoverRadius: 4,
      tension: 0.25,
      fill: false,
      order: isCurrent ? 0 : 1,
    };
  });

  _makeChart(canvasId, {
    type: "line",
    data: { labels: MONTH_LABELS, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      // interaction: index/intersect:false — ADDED 2026-07-26, per Jason
      // directly, against a real vendor screenshot: hovering anywhere over
      // a month now pops up ONE tooltip breaking down every visible year's
      // value for that month (oldest to newest, matching legend order),
      // instead of only the single nearest line's value.
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: "index",
          intersect: false,
          // itemSort — without this, Chart.js sorts tooltip rows by each
          // dataset's `order` field, which is also (separately) used above
          // to draw the current year's line on top. That coupling put 2026
          // first in the tooltip. Sorting by label here instead gives the
          // vendor's real oldest-to-newest order regardless of draw order.
          itemSort: (a, b) => a.dataset.label.localeCompare(b.dataset.label),
          callbacks: yFormat ? { label: (ctx) => `${ctx.dataset.label}: ${yFormat(ctx.parsed.y)}` } : undefined,
        },
      },
      scales: {
        x: { grid: { display: false } },
        y: { ticks: yFormat ? { callback: (v) => yFormat(v) } : undefined },
      },
    },
  });
}

// ---------------------------------------------------------------------
// Simple one-bar-per-period chart with the most recent bar emphasized
// (Renewals — Trailing 12 Mo).
// ---------------------------------------------------------------------
function emphasizedBarChartHtml({ canvasId, labels, data }) {
  queueMicrotask(() => renderEmphasizedBarChart({ canvasId, labels, data }));
  return `<div class="chart-canvas-wrap" style="height:180px;"><canvas id="${canvasId}"></canvas></div>`;
}

function renderEmphasizedBarChart({ canvasId, labels, data }) {
  _makeChart(canvasId, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          data,
          backgroundColor: data.map((_, i) => (i === data.length - 1 ? LH_COLORS.green : "#bcd4c2")),
          borderRadius: 3,
          maxBarThickness: 22,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true },
      },
    },
  });
}

// ---------------------------------------------------------------------
// Donut/ring chart with side legend (Property Health) — arbitrary list
// of named categories, not hardcoded to 6.
// ---------------------------------------------------------------------
function donutWithLegendHtml({ canvasId, categories }) {
  // categories: [{ label, count }]
  queueMicrotask(() => renderDonut({ canvasId, categories }));
  const total = categories.reduce((sum, c) => sum + c.count, 0);
  const legendRows = categories
    .map((c, i) => {
      const color = colorForCategory(c.label, i);
      return `
      <div class="donut-legend-row">
        <span class="donut-legend-swatch" style="background:${color};"></span>
        <span class="donut-legend-label">${c.label}</span>
        <span class="donut-legend-count">${formatNumber(c.count)}</span>
      </div>
    `;
    })
    .join("");
  return `
    <div class="donut-layout">
      <div class="donut-canvas-wrap">
        <canvas id="${canvasId}"></canvas>
        <div class="ring-gauge-value" style="font-size:15px;">${formatNumber(total)}</div>
      </div>
      <div class="donut-legend">${legendRows}</div>
    </div>
  `;
}

function renderDonut({ canvasId, categories }) {
  _makeChart(canvasId, {
    type: "doughnut",
    data: {
      labels: categories.map((c) => c.label),
      datasets: [
        {
          data: categories.map((c) => c.count),
          backgroundColor: categories.map((c, i) => colorForCategory(c.label, i)),
          borderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      cutout: "68%",
      plugins: {
        legend: { display: false },
      },
    },
  });
}

// ---------------------------------------------------------------------
// Single-value ring gauge (percent), e.g. Team Performance overall score.
// ---------------------------------------------------------------------
function ringGaugeHtml({ canvasId, percent, size = 84, color, label }) {
  const clamped = Math.max(0, Math.min(100, percent));
  const gaugeColor = color || ringColorForPercent(clamped);
  queueMicrotask(() => renderRingGauge({ canvasId, percent: clamped, color: gaugeColor }));
  const displayLabel = label !== undefined ? label : `${Math.round(clamped)}%`;
  return `
    <div class="ring-gauge" style="width:${size}px;height:${size}px;flex-shrink:0;">
      <canvas id="${canvasId}"></canvas>
      <div class="ring-gauge-value" style="font-size:${size < 70 ? 13 : 18}px;">${displayLabel}</div>
    </div>
  `;
}

function ringColorForPercent(percent) {
  if (percent >= 80) return LH_COLORS.green;
  if (percent >= 50) return LH_COLORS.amber;
  return LH_COLORS.red;
}

function renderRingGauge({ canvasId, percent, color }) {
  _makeChart(canvasId, {
    type: "doughnut",
    data: {
      datasets: [
        {
          data: [percent, 100 - percent],
          backgroundColor: [color, "#eef0f3"],
          borderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      cutout: "72%",
      circumference: 360,
      rotation: 0,
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
      },
    },
  });
}

// ---------------------------------------------------------------------
// Horizontal proportional bars — used for Delinquency Aging, Leasing
// Funnel, and New Prospects by Source. Width of each bar is proportional
// to that row's value relative to the largest value in the list.
// ---------------------------------------------------------------------
function horizontalBarListHtml({ rows, className = "" }) {
  // rows: [{ label, value, displayValue, color, change, tileId }]
  // tileId is optional — ADDED 2026-07-13 for the Leasing Funnel chart's
  // per-stage drill-downs. When present, the row gets the same
  // data-tile-id attribute a regular tile uses, so the existing
  // wireTileClicks()/handleTileClick() dispatch picks it up with no
  // separate click-wiring path. Rows without a tileId (Delinquency Aging,
  // New Prospects by Source) are unaffected.
  const maxValue = Math.max(...rows.map((r) => r.value), 1);
  return `
    <div class="hbar-list">
      ${rows
        .map((r) => {
          const pct = Math.max(3, Math.round((r.value / maxValue) * 100));
          const changeHtml = r.change
            ? `<span class="hbar-row-change ${r.change.direction}">${r.change.text}</span>`
            : "";
          const tileAttr = r.tileId ? ` data-tile-id="${r.tileId}"` : "";
          const clickableClass = r.tileId ? " clickable" : "";
          return `
          <div class="hbar-row ${className}${clickableClass}"${tileAttr}>
            <div class="hbar-row-top">
              <span class="hbar-row-label">${r.label}</span>
              <span><span class="hbar-row-value">${r.displayValue}</span>${changeHtml}</span>
            </div>
            <div class="hbar-track">
              <div class="hbar-fill" style="width:${pct}%;background:${r.color};"></div>
            </div>
          </div>
        `;
        })
        .join("")}
    </div>
  `;
}
