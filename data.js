// ELN Pricer — ticker universe + real data layer (candles + option IV)
// Primary source: marketdata.app (no key, CORS *, brokerage-grade IV+greeks)
// Fallback: Yahoo chart (client residential IP), then seeded sample.

const UNIVERSE = [
  ["SNDK","SNDK","SanDisk Corp"],
  ["MU","MU","Micron Technology"],
  ["DRAM","DRAM","Roundhill Memory ETF"],
  ["INTC","INTC","Intel Corp"],
  ["AMD","AMD","Advanced Micro Devices"],
  ["ARM","ARM","Arm Holdings"],
  ["DELL","DELL","Dell Technologies"],
  ["KLAC","KLAC","KLA Corp"],
  ["AMAT","AMAT","Applied Materials"],
  ["LRCX","LRCX","Lam Research"],
  ["AMKR","AMKR","Amkor Technology"],
  ["NVDA","NVDA","NVIDIA Corp"],
  ["AAPL","AAPL","Apple Inc"],
  ["TSM","TSM","Taiwan Semiconductor ADR"],
  ["ASX","ASX","ASE Technology ADR (日月光)"],
  ["LITE","LITE","Lumentum Holdings"],
  ["COHR","COHR","Coherent Corp"],
  ["MRVL","MRVL","Marvell Technology"],
  ["CRDO","CRDO","Credo Technology"],
  ["992","0992.HK","Lenovo Group"],
  ["9992","9992.HK","Pop Mart 09992.HK"],
  ["700","0700.HK","Tencent Holdings"],
  ["9988","9988.HK","Alibaba Group"],
  ["3690","3690.HK","Meituan"],
  ["388","0388.HK","Hong Kong Exchanges (HKEX)"],
  ["5","0005.HK","HSBC Holdings 滙豐控股"],
  ["9999","9999.HK","NetEase 網易"],
  ["1211","1211.HK","BYD 比亞迪"],
  ["2388","2388.HK","BOC Hong Kong 中銀香港"],
  ["9618","9618.HK","JD.com 京東"],
  ["1347","1347.HK","Hua Hong Semi 華虹半導體"]
];
// HK tickers marketdata.app doesn't cover free → force Yahoo/sample
const isHK = y => /\.HK$/i.test(y);
function usSym(input){
  const t=(input||"").trim().toUpperCase();
  const u=UNIVERSE.find(x=>x[0].toUpperCase()===t||x[1]===t);
  if(u) return u[1];
  // pure digits = HK stock code → normalize to Yahoo 4-digit .HK
  if(/^\d{1,5}$/.test(t)) return (t.length<4?t.padStart(4,"0"):t)+".HK";
  return t;
}
function tickerName(input){
  const y=usSym(input); const u=UNIVERSE.find(x=>x[1]===y);
  return u?u[2]:"(自訂 ticker)";
}

// ---- CONFIG: data providers ----
// 你自己嘅 Cloudflare Worker proxy：統一 source（美股+港股 K 線 + 自動 option IV）
const WORKER_URL = "https://eln-proxy.leunghlk.workers.dev";
const TD_KEY = "ff430ea8397d4163995861d40bf28314";  // Twelve Data 後備（美股）
const FINNHUB_KEY = "d9iu7nhr01qvkt7ea1l0d9iu7nhr01qvkt7ea1lg"; // 即時報價後備

// ---- CANDLES (Worker/Yahoo primary → Twelve Data → sample) ----
async function fetchCandles(input, range){
  const y=usSym(input);
  const days = range==="3mo"?66:range==="6mo"?132:range==="1y"?252:range==="3y"?756:range==="5y"?1260:range==="10y"?2520:252;
  const yr = ["3mo","6mo","1y","3y","5y","10y"].includes(range)?range:"1y";
  // 1) Worker proxy → Yahoo（美股+港股統一，有 CORS）
  try{
    const url=`${WORKER_URL}/chart?symbol=${encodeURIComponent(y)}&range=${yr}&interval=1d`;
    const r=await fetch(url); const j=await r.json();
    const res=j&&j.chart&&j.chart.result&&j.chart.result[0];
    if(res&&res.timestamp){
      const q=res.indicators.quote[0];
      const out=res.timestamp.map((t,i)=>({time:isoFromUnix(t),open:q.open[i],high:q.high[i],low:q.low[i],close:q.close[i]}))
        .filter(d=>d.open!=null&&d.close!=null);
      if(out.length) return {data:out, source:"live", provider:"Yahoo (proxy)"};
    }
  }catch(e){}
  // 2) Twelve Data 後備（美股）
  try{
    let tdSymbol=y, tdExtra="";
    if(isHK(y)){ tdSymbol=y.replace(/\.HK$/i,"").replace(/^0+/,""); tdExtra="&exchange=HKEX"; }
    const url=`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdSymbol)}${tdExtra}&interval=1day&outputsize=${days}&apikey=${TD_KEY}`;
    const r=await fetch(url); const j=await r.json();
    if(j.status!=="error" && Array.isArray(j.values) && j.values.length){
      const out=j.values.map(v=>({time:v.datetime,open:+v.open,high:+v.high,low:+v.low,close:+v.close})).reverse();
      return {data:out, source:"live", provider:"Twelve Data"};
    }
  }catch(e){}
  return {data:sampleCandles(days), source:"sample", provider:"sample"};
}
function isoFromUnix(u){return new Date(u*1000).toISOString().slice(0,10);}
function sampleCandles(days){
  const arr=[];let px=100+Math.random()*50;const today=new Date();
  for(let i=days;i>0;i--){const d=new Date(today);d.setDate(d.getDate()-i);
    const o=px,ch=(Math.random()-0.48)*6,c=o+ch;
    const hi=Math.max(o,c)+Math.random()*2,lo=Math.min(o,c)-Math.random()*2;
    arr.push({time:d.toISOString().slice(0,10),open:+o.toFixed(2),high:+hi.toFixed(2),low:+lo.toFixed(2),close:+c.toFixed(2)});
    px=c;}
  return arr;
}

// ---- OPTION IV: primary = Worker /iv-cboe (CBOE 30d implied IV, key-free, accurate) ----
//   fallback 1: /iv-yahoo (Yahoo 3M ATM implied IV; currently Yahoo rate-limited)
//   fallback 2: /iv (90日 realized vol, 自動, 唔使 Yahoo crumb)
//   fallback 3: 靜態 BLOOMBERG_IV (worker 死機時 offline 後備)
//   fallback 4: sample
//   HK 冇 CBOE/Yahoo options → 自動落 /iv (realized) → BLOOMBERG_IV
// Returns {atm, atStrike, spot, source, expiry, strikeUsed}
async function fetchIV(input, tenorMonths, strikePct){
  const y=usSym(input);
  const tk=normSym(y);
  // ---- 1) Worker /iv-cboe (primary, CBOE 30d implied IV) ----
  try{
    const r=await fetch(`${WORKER_URL}/iv-cboe?symbol=${encodeURIComponent(y)}`);
    const j=await r.json();
    if(j && j.iv_pct!=null && j.iv_pct>0){
      const iv=j.iv_pct/100;
      return {atm:iv, atStrike:iv, spot:j.spot||null,
        source:"cboe_iv30", expiry:"30d IV", strikeUsed:null,
        worker_source:j.source, as_of:j.as_of};
    }
  }catch(e){}
  // ---- 2) Worker /iv-yahoo (Yahoo 3M ATM implied IV) ----
  try{
    const r=await fetch(`${WORKER_URL}/iv-yahoo?symbol=${encodeURIComponent(y)}`);
    const j=await r.json();
    if(j && j.iv_pct!=null && j.iv_pct>0){
      const iv=j.iv_pct/100;
      return {atm:iv, atStrike:iv, spot:null,
        source: j.source==="bloomberg_fallback" ? "bloomberg_fallback" : "worker_auto",
        expiry:"3M ATM", strikeUsed:null,
        worker_source: j.source, atm_strike: j.atm_strike||null};
    }
  }catch(e){}
  // ---- 3) /iv (90日 realized vol, 自動, 唔使 Yahoo options crumb) ----
  try{
    const r=await fetch(`${WORKER_URL}/iv?symbol=${encodeURIComponent(y)}&window=90`);
    const j=await r.json();
    if(j && j.realized_iv_pct!=null){
      const iv=j.realized_iv_pct/100;
      return {atm:iv, atStrike:iv, spot:null, source:"auto", expiry:j.as_of, strikeUsed:null, autoWindow:"90d"};
    }
  }catch(e){}
  // ---- 4) Offline 後備: 靜態 BLOOMBERG_IV ----
  const bbg=(typeof BLOOMBERG_IV!=='undefined')?BLOOMBERG_IV[tk]:null;
  if(bbg && bbg>0){
    return {atm:bbg, atStrike:bbg, spot:null, source:"bloomberg_offline", expiry:"3M 100%-moneyness", strikeUsed:null};
  }
  // ---- 5) 最後: sample ----
  const seed=0.30+Math.random()*0.25;
  return {atm:seed, atStrike:seed, spot:null, source:"sample", expiry:null, strikeUsed:null};
}
