// ELN Pricer — Cloudflare Worker proxy
// 用途：俾 hosted dashboard（GitHub Pages）攞 Yahoo Finance 真實數據，
//       解決 (1) CORS 阻擋、(2) 港股+美股 K 線、(3) 自動 option IV（Yahoo crumb）。
//
// 部署方法見 DEPLOY-worker.md。部署後會得到一條 URL，例如：
//   https://eln-proxy.<你的子域>.workers.dev
// 將該 URL 填入 data.js 的 WORKER_URL。
//
// 端點：
//   /chart?symbol=AAPL&range=6mo&interval=1d      → K 線
//   /chart?symbol=0700.HK&range=6mo&interval=1d   → 港股 K 線
//   /options?symbol=SNDK                          → option chain（含 IV）
//   /options?symbol=SNDK&date=1737676800          → 指定到期日

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
        return json({ ok: true, service: "eln-proxy", endpoints: ["/chart", "/options"] });
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
      return json({ error: "unknown path", path }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};
