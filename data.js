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
  ["9992","9992.HK","Pop Mart? 請確認 09992.HK"],
  ["700","0700.HK","Tencent Holdings"],
  ["9988","9988.HK","Alibaba Group"],
  ["3690","3690.HK","Meituan"],
  ["388","0388.HK","Hong Kong Exchanges (HKEX)"]
];
// HK tickers marketdata.app doesn't cover free → force Yahoo/sample
const isHK = y => /\.HK$/i.test(y);
function usSym(input){
  const t=(input||"").trim().toUpperCase();
  const u=UNIVERSE.find(x=>x[0].toUpperCase()===t||x[1]===t);
  return u?u[1]:t;
}
function tickerName(input){
  const y=usSym(input); const u=UNIVERSE.find(x=>x[1]===y);
  return u?u[2]:"(自訂 ticker)";
}

// ---- CONFIG: data provider keys (Twelve Data native CORS for candles) ----
const TD_KEY = "ff430ea8397d4163995861d40bf28314";  // Twelve Data (美股真實 K 線；港股需付費 plan)
const FINNHUB_KEY = "d9iu7nhr01qvkt7ea1l0d9iu7nhr01qvkt7ea1lg"; // 即時報價用

// ---- CANDLES (Twelve Data primary → Finnhub US quote spot → sample) ----
async function fetchCandles(input, range){
  const y=usSym(input);
  const days = range==="3mo"?66:range==="6mo"?132:252;
  // Twelve Data: US uses bare symbol; HK uses number + exchange=HKEX
  let tdSymbol=y, tdExtra="";
  if(isHK(y)){ tdSymbol=y.replace(/\.HK$/i,"").replace(/^0+/,""); tdExtra="&exchange=HKEX"; }
  try{
    const url=`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdSymbol)}${tdExtra}&interval=1day&outputsize=${days}&apikey=${TD_KEY}`;
    const r=await fetch(url); const j=await r.json();
    if(j.status!=="error" && Array.isArray(j.values) && j.values.length){
      const out=j.values.map(v=>({time:v.datetime,open:+v.open,high:+v.high,low:+v.low,close:+v.close}))
        .reverse();
      return {data:out, source:"live", provider:"Twelve Data"};
    }
  }catch(e){}
  // Yahoo fallback (works on residential IP / your Mac; may be CORS-blocked when hosted)
  try{
    const yr = range==="3mo"?"3mo":range==="6mo"?"6mo":"1y";
    const url=`https://query1.finance.yahoo.com/v8/finance/chart/${y}?range=${yr}&interval=1d`;
    const r=await fetch(url); const j=await r.json(); const res=j.chart.result[0];
    const q=res.indicators.quote[0];
    const out=res.timestamp.map((t,i)=>({time:isoFromUnix(t),open:q.open[i],high:q.high[i],low:q.low[i],close:q.close[i]}))
      .filter(d=>d.open!=null&&d.close!=null);
    if(out.length) return {data:out, source:"live", provider:"Yahoo"};
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

// ---- OPTION IV (at target strike + ATM) ----
// Returns {atm, atStrike, spot, source, expiry}
async function fetchIV(input, tenorMonths, strikePct){
  const y=usSym(input);
  if(!isHK(y)){
    try{
      // nearest expiry >= tenor
      const exp=await fetch(`https://api.marketdata.app/v1/options/expirations/${y}/`);
      const ej=await exp.json();
      if(ej.s==="ok" && ej.expirations && ej.expirations.length){
        const targetDte=tenorMonths*30;
        const now=Math.floor(Date.now()/1000);
        let best=ej.expirations[0], bestDiff=1e9;
        ej.expirations.forEach(ds=>{
          const t=Math.floor(new Date(ds+"T00:00:00Z").getTime()/1000);
          const dte=(t-now)/86400; const diff=Math.abs(dte-targetDte);
          if(dte>5 && diff<bestDiff){bestDiff=diff;best=ds;}
        });
        const ch=await fetch(`https://api.marketdata.app/v1/options/chain/${y}/?expiration=${best}&side=put`);
        const cj=await ch.json();
        if(cj.s==="ok" && cj.strike && cj.strike.length){
          const spot=cj.underlyingPrice[0];
          // ATM = strike closest to spot; atStrike = closest to spot*strikePct
          let iAtm=0,iK=0,dA=1e9,dK=1e9;
          const kTarget=spot*(strikePct/100);
          cj.strike.forEach((s,i)=>{
            if(cj.iv[i]==null)return;
            if(Math.abs(s-spot)<dA){dA=Math.abs(s-spot);iAtm=i;}
            if(Math.abs(s-kTarget)<dK){dK=Math.abs(s-kTarget);iK=i;}
          });
          return {atm:cj.iv[iAtm], atStrike:cj.iv[iK], spot, source:"live", expiry:best,
                  strikeUsed:cj.strike[iK]};
        }
      }
    }catch(e){}
  }
  // no live IV → seeded sample by sector vol
  const seed = 0.42 + Math.random()*0.15;
  return {atm:seed, atStrike:seed*1.35, spot:null, source:"sample", expiry:null, strikeUsed:null};
}
