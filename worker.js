// ELN Pricer — Cloudflare Worker proxy
// 用途：俾 hosted dashboard（GitHub Pages）攞 Yahoo Finance 真實數據，
//       解決 (1) CORS 阻擋、(2) 港股+美股 K 線、(3) 自動 option IV（Yahoo crumb）、
//       (4) 港股/美股 realized volatility（90日年化，做 IV proxy）。
//
// 端點：
//   /chart?symbol=AAPL&range=6mo&interval=1d      → K 線
//   /chart?symbol=0700.HK&range=6mo&interval=1d   → 港股 K 線
//   /options?symbol=SNDK                          → option chain（含 IV，美股）
//   /options?symbol=SNDK&date=1737676800          → 指定到期日
//   /iv?symbol=0700.HK&window=90               → 90日 realized vol（年化 %）
//   /iv?symbol=AAPL&window=90                   → 美股 90日 realized vol

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Cache-Control": "no-store",
};

// 快取 crumb/cookie（Worker 全域，冷啟動後重取）
let CRUMB = null, COOKIE = null, CRUMB_TS = 0;

async function ensureCrumb(force) {
  const fresh = Date.now() - CRUMB_TS < 30 * 60 * 1000; // 30 分鐘
  if (!force && CRUMB && COOKIE && fresh) return;
  // 步驟 1：攞 cookie
  const r1 = await fetch("https://fc.yahoo.com/", { headers: { "User-Agent": UA } });
  let ck = "";
  if (typeof r1.headers.getSetCookie === "function") {
    ck = r1.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  } else {
    const sc = r1.headers.get("set-cookie") || "";
    ck = sc.split(",").map(c => c.split(";")[0]).join("; ");
  }
  // 步驟 2：用 cookie 攞 crumb
  const r2 = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": UA, "Cookie": ck },
  });
  const crumb = (await r2.text()).trim();
  if (crumb && !crumb.includes("<")) { CRUMB = crumb; COOKIE = ck; CRUMB_TS = Date.now(); }
}

// 計 realized vol（年化），window = 交易日數（90 = 約 3 個月）
function realizedVol(closes, window) {
  const c = closes.filter(x => x != null && !isNaN(x));
  if (c.length < 5) return null;
  const w = Math.min(window || 90, c.length - 1);
  const slice = c.slice(-(w + 1));
  const rets = [];
  for (let i = 1; i < slice.length; i++) {
    if (slice[i - 1] > 0) rets.push(Math.log(slice[i] / slice[i - 1]));
  }
  if (rets.length < 5) return null;
  const n = rets.length;
  const m = rets.reduce((a, b) => a + b, 0) / n;
  const variance = rets.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  const annual = sd * Math.sqrt(252);
  // 同時返 1y realized 做對照
  const rets1y = [];
  for (let i = 1; i < c.length; i++) {
    if (c[i - 1] > 0) rets1y.push(Math.log(c[i] / c[i - 1]));
  }
  const n1 = rets1y.length;
  const m1 = rets1y.reduce((a, b) => a + b, 0) / n1;
  const v1 = rets1y.reduce((a, b) => a + (b - m1) ** 2, 0) / (n1 - 1);
  const annual1y = Math.sqrt(v1) * Math.sqrt(252);
  return {
    window_days: w,
    realized_iv_pct: +(annual * 100).toFixed(2),
    realized_1y_pct: +(annual1y * 100).toFixed(2),
    bars: c.length,
    as_of: new Date().toISOString().slice(0, 10),
  };
}

function json(body, status = 200) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body),
    { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");
    try {
      if (path === "" || path === "/") {
        return json({ ok: true, service: "eln-proxy", endpoints: ["/chart", "/options", "/iv"] });
      }
      if (path === "/chart") {
        const symbol = url.searchParams.get("symbol");
        if (!symbol) return json({ error: "symbol required" }, 400);
        const range = url.searchParams.get("range") || "6mo";
        const interval = url.searchParams.get("interval") || "1d";
        const y = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
        const r = await fetch(y, { headers: { "User-Agent": UA } });
        return new Response(await r.text(), { headers: { ...CORS, "Content-Type": "application/json" } });
      }
      if (path === "/options") {
        const symbol = url.searchParams.get("symbol");
        if (!symbol) return json({ error: "symbol required" }, 400);
        const date = url.searchParams.get("date");
        for (let attempt = 0; attempt < 2; attempt++) {
          await ensureCrumb(attempt === 1);
          let y = `https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}`;
          y += `?crumb=${encodeURIComponent(CRUMB || "")}`;
          if (date) y += `&date=${date}`;
          const r = await fetch(y, { headers: { "User-Agent": UA, "Cookie": COOKIE || "" } });
          const txt = await r.text();
          if (!txt.includes("Invalid Crumb") && !txt.includes("Unauthorized")) {
            return new Response(txt, { headers: { ...CORS, "Content-Type": "application/json" } });
          }
        }
        return json({ error: "crumb_failed" }, 502);
      }
      // /iv — realized vol（年化），做 IV proxy（港股無 options IV，用此）
      if (path === "/iv") {
        const symbol = url.searchParams.get("symbol");
        if (!symbol) return json({ error: "symbol required" }, 400);
        const win = +(url.searchParams.get("window") || "90");
        const range = win >= 252 ? "5y" : "1y";
        const y = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
        const r = await fetch(y, { headers: { "User-Agent": UA } });
        const txt = await r.text();
        let d;
        try { d = JSON.parse(txt); } catch (e) { return json({ error: "bad_yahoo", raw: txt.slice(0, 200) }, 502); }
        const res = d.chart && d.chart.result && d.chart.result[0];
        if (!res) return json({ error: "no_data", note: d.chart && d.chart.error }, 404);
        const closes = (res.indicators && res.indicators.quote && res.indicators.quote[0].close) || [];
        const vol = realizedVol(closes, win);
        if (!vol) return json({ error: "insufficient_bars" }, 422);
        return json({ symbol: res.meta && res.meta.symbol, ...vol, source: "yahoo_realized_vol" });
      }
      return json({ error: "unknown path", path }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};
