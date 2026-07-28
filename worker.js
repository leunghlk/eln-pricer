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
// /iv-yahoo per-ticker cache
const IVY_CACHE = new Map();
// /iv-cboe per-ticker cache
const CB_CACHE = new Map();
// Bloomberg 3M 100%-moneyness IV fallback（與 bs_calib_data.js 一致；Yahoo 返 0 時用）
const BLOOMBERG_FALLBACK = {
  "CRDO":1.1122,"LITE":0.9968,"AMKR":0.9849,"COHR":0.9777,"DRAM":0.9496,"ARM":0.9496,
  "MRVL":0.9147,"MU":0.9073,"KLAC":0.8952,"ASX":0.8782,"LRCX":0.8684,"AMAT":0.8558,
  "DELL":0.8532,"INTC":0.8091,"AMD":0.7547,"TSM":0.4917,"NVDA":0.4274,
  "SNDK":1.2053,"AAPL":0.280194,
  "1347":0.9059,"992":0.6366,"9992":0.4818,"3690":0.4483,"1211":0.4037,"9999":0.3871,
  "9618":0.3616,"9988":0.4446,"700":0.3381,"5":0.2617,"2388":0.2377,"388":0.2349,
  "ALAB":1.1223,"SKHY":1.0948,"SOXX":0.6012,
};

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
        return json({ ok: true, service: "eln-proxy", endpoints: ["/chart", "/options", "/iv", "/iv-yahoo", "/iv-cboe"] });
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
      // /iv-yahoo — 從 Yahoo option chain 抽 3M ATM IV（自動化 IV，免人手手抄）
      //   DELL/ASX 等 Yahoo 返 impliedVolatility=0 嘅，fallback 去 Bloomberg 名單
      if (path === "/iv-yahoo") {
        const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
        if (!symbol) return json({ error: "symbol required" }, 400);
        // per-ticker cache（60 分鐘）
        const cacheKey = "ivy:" + symbol;
        const cached = IVY_CACHE.get(cacheKey);
        if (cached && Date.now() - cached.ts < 60 * 60 * 1000) {
          return json({ ...cached.data, cached: true });
        }
        // 1) 攞 Yahoo option chain
        let chain = null;
        for (let attempt = 0; attempt < 2 && !chain; attempt++) {
          await ensureCrumb(attempt === 1);
          const y = `https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}?crumb=${encodeURIComponent(CRUMB || "")}`;
          const r = await fetch(y, { headers: { "User-Agent": UA, "Cookie": COOKIE || "" } });
          const txt = await r.text();
          if (!txt.includes("Invalid Crumb") && !txt.includes("Unauthorized")) {
            try { chain = JSON.parse(txt); } catch (e) { chain = null; }
          }
        }
        if (!chain || !chain.optionChain || !chain.optionChain[0]) {
          return json({ error: "no_option_chain", symbol }, 502);
        }
        const oc = chain.optionChain[0];
        const expirations = oc.expirationDates || [];
        if (!expirations.length) return json({ error: "no_expirations", symbol }, 422);
        // 2) 揀最接近 3 個月（90 日）嘅到期日
        const now = Math.floor(Date.now() / 1000);
        const target = now + 90 * 24 * 3600;
        let exp = expirations[0], best = Infinity;
        for (const e of expirations) {
          const diff = Math.abs(e - target);
          if (diff < best) { best = diff; exp = e; }
        }
        // 揀該到期日嘅 chain（若 Yahoo 未載入該日，重攞一次）
        let calls = oc.options && oc.options.find(o => o.expirationDate === exp && o.calls) ? oc.options.find(o => o.expirationDate === exp).calls : null;
        let puts = oc.options && oc.options.find(o => o.expirationDate === exp && o.puts) ? oc.options.find(o => o.expirationDate === exp).puts : null;
        if (!calls || !puts) {
          const y2 = `https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}?crumb=${encodeURIComponent(CRUMB || "")}&date=${exp}`;
          const r2 = await fetch(y2, { headers: { "User-Agent": UA, "Cookie": COOKIE || "" } });
          try { const c2 = JSON.parse(await r2.text()); const oc2 = c2.optionChain && c2.optionChain[0];
            calls = oc2 && oc2.options && oc2.options[0] && oc2.options[0].calls;
            puts  = oc2 && oc2.options && oc2.options[0] && oc2.options[0].puts;
          } catch (e) {}
        }
        if (!calls || !puts || !calls.length || !puts.length) {
          return json({ error: "no_contracts", symbol, exp }, 422);
        }
        // 3) 計 ATM strike（用 underlying 或 call/put strike 中間）
        const und = (oc.quote && oc.quote.regularMarketPrice) || (calls[0] && calls[0].strike);
        const atmStrike = und || calls[Math.floor(calls.length / 2)].strike;
        // 搵 ATM 附近（±5% strike）call/put IV，取平均
        function atmIv(arr) {
          const near = arr.filter(o => o.strike >= atmStrike * 0.95 && o.strike <= atmStrike * 1.05 && o.impliedVolatility > 0);
          if (!near.length) return null;
          const avg = near.reduce((a, o) => a + o.impliedVolatility, 0) / near.length;
          return avg;
        }
        const ivC = atmIv(calls), ivP = atmIv(puts);
        let iv = null;
        if (ivC != null && ivP != null) iv = (ivC + ivP) / 2;
        else if (ivC != null) iv = ivC;
        else if (ivP != null) iv = ivP;
        const tenorMonths = +((exp - now) / (30.44 * 24 * 3600)).toFixed(2);
        if (iv == null || !(iv > 0)) {
          // 4) Yahoo 返 0 / 搵唔到 → fallback Bloomberg 名單
          const bb = BLOOMBERG_FALLBACK[symbol.replace(/\.HK$/i, "").replace(/^0+/, "")] ?? BLOOMBERG_FALLBACK[symbol];
          if (bb != null) {
            const data = { symbol, iv_pct: +(bb * 100).toFixed(2), tenor_months: 3, atm_strike: atmStrike, source: "bloomberg_fallback", yahoo_iv: null, note: "Yahoo returned 0/NA → used Bloomberg 3M 100%-moneyness IV" };
            IVY_CACHE.set(cacheKey, { ts: Date.now(), data });
            return json(data);
          }
          return json({ error: "no_valid_iv", symbol, yahoo_iv: null, atm_strike: atmStrike }, 422);
        }
        const data = { symbol, iv_pct: +(iv * 100).toFixed(2), tenor_months: tenorMonths, atm_strike: atmStrike, source: "yahoo_options_atm_3m", yahoo_iv: +(iv * 100).toFixed(2) };
        IVY_CACHE.set(cacheKey, { ts: Date.now(), data });
        return json(data);
      }
      // /iv-cboe — CBOE delayed options: 30-day implied IV (iv30) + spot. Key-free, no crumb.
      //   Most accurate free implied-IV source; covers all US stocks. HK not on CBOE → caller falls back.
      if (path === "/iv-cboe") {
        const symbol = (url.searchParams.get("symbol") || "").toUpperCase().replace(/\.HK$/i, "");
        if (!symbol) return json({ error: "symbol required" }, 400);
        const cacheKey = "cboe:" + symbol;
        const cached = CB_CACHE.get(cacheKey);
        if (cached && Date.now() - cached.ts < 30 * 60 * 1000) {
          return json({ ...cached.data, cached: true });
        }
        const r = await fetch(`https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(symbol)}.json`, { headers: { "User-Agent": UA } });
        const j = await r.json().catch(() => null);
        if (!j || !j.data || j.data.iv30 == null) {
          return json({ error: "no_cboe_data", symbol }, 404);
        }
        const data = {
          symbol,
          iv_pct: +(j.data.iv30).toFixed(2),
          spot: j.data.current_price != null ? +j.data.current_price : null,
          tenor_months: 1,            // iv30 = 30-day implied vol
          source: "cboe_iv30",
          as_of: j.data.last_trade_time || new Date().toISOString().slice(0, 10),
        };
        CB_CACHE.set(cacheKey, { ts: Date.now(), data });
        return json(data);
      }
      return json({ error: "unknown path", path }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};
