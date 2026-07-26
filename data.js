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

// ---- OPTION IV (at target strike + ATM) via Worker → Yahoo option chain ----
// Returns {atm, atStrike, spot, source, expiry, strikeUsed}
// 自動攞即時 IV：唔使再手動抄數據（解決效率問題）
async function fetchIV(input, tenorMonths, strikePct){
  const y=usSym(input);
  try{
    // 1) 攞到期日列表（default chain 已含最近到期）
    const r0=await fetch(`${WORKER_URL}/options?symbol=${encodeURIComponent(y)}`);
    const j0=await r0.json();
    const res0=j0&&j0.optionChain&&j0.optionChain.result&&j0.optionChain.result[0];
    if(res0){
      const exps=res0.expirationDates||[];
      const spot=res0.quote&&(res0.quote.regularMarketPrice||res0.quote.postMarketPrice);
      // 揀最接近 tenor 嘅到期日
      const now=Math.floor(Date.now()/1000);
      const targetDte=tenorMonths*30;
      let best=null,bestDiff=1e9;
      exps.forEach(t=>{const dte=(t-now)/86400;const diff=Math.abs(dte-targetDte);
        if(dte>3&&diff<bestDiff){bestDiff=diff;best=t;}});
      // 攞該到期日 chain
      let chain=res0;
      if(best && exps.length){
        const r1=await fetch(`${WORKER_URL}/options?symbol=${encodeURIComponent(y)}&date=${best}`);
        const j1=await r1.json();
        chain=(j1&&j1.optionChain&&j1.optionChain.result&&j1.optionChain.result[0])||res0;
      }
      const opt=chain.options&&chain.options[0];
      const puts=(opt&&opt.puts)||[];
      const sp=spot||(chain.quote&&chain.quote.regularMarketPrice);
      if(puts.length&&sp){
        const kTarget=sp*(strikePct/100);
        let iAtm=-1,iK=-1,dA=1e9,dK=1e9;
        puts.forEach((p,i)=>{
          if(p.impliedVolatility==null||!p.strike)return;
          if(Math.abs(p.strike-sp)<dA){dA=Math.abs(p.strike-sp);iAtm=i;}
          if(Math.abs(p.strike-kTarget)<dK){dK=Math.abs(p.strike-kTarget);iK=i;}
        });
        if(iAtm>=0){
          const expDate=new Date((opt.expirationDate||best)*1000).toISOString().slice(0,10);
          return {atm:puts[iAtm].impliedVolatility,
                  atStrike:iK>=0?puts[iK].impliedVolatility:puts[iAtm].impliedVolatility,
                  spot:sp, source:"live", expiry:expDate,
                  strikeUsed:iK>=0?puts[iK].strike:puts[iAtm].strike};
        }
      }
    }
  }catch(e){}
  // no live IV → seeded sample by sector vol
  const seed = 0.42 + Math.random()*0.15;
  return {atm:seed, atStrike:seed*1.35, spot:null, source:"sample", expiry:null, strikeUsed:null};
}
