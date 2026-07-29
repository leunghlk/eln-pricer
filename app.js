// ELN Pricer — app wiring
let LANG=localStorage.getItem("eln_lang")||"tc";
let CHARTS=[];            // array of {chart,series,_call,_put,_sma}
let CUR={};               // current solved state for chart lines {spot,call,put}
let LAST_IV=null;        // last IV object (primary ticker)
let BASKET=[];           // selected tickers for basket
let BASKET_IV=[];       // [{sym, ivK, ivA}] fetched for basket members
let SMA_ON=false,SMA_N=10;
const $=id=>document.getElementById(id);
const fmt=(n,d=2)=>(n==null||isNaN(n))?"—":Number(n).toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d});
const pct=(n,d=2)=>(n==null||isNaN(n))?"—":Number(n).toFixed(d)+"%";
const sym=c=>({USD:"US$",HKD:"HK$",EUR:"€"}[c]||"");
function toast(t){const m=$("msg");m.textContent=t;m.style.display="block";clearTimeout(m._t);m._t=setTimeout(()=>m.style.display="none",3600);}
function T(k){return (I18N[LANG]&&I18N[LANG][k])||k;}

function applyLang(){
  document.querySelectorAll("[data-i]").forEach(el=>{el.textContent=T(el.dataset.i);});
  document.querySelectorAll(".langsw button").forEach(b=>b.classList.toggle("on",b.dataset.l===LANG));
  document.documentElement.lang = LANG==="en"?"en":(LANG==="sc"?"zh-CN":"zh-HK");
  if(CUR.spot) recompute();
}

function readParams(){
  const single = !$("basketPane").style.display || $("basketPane").style.display==="none";
  let basket=[];
  if(!single){
    [ "bk1","bk2","bk3" ].forEach(id=>{ const v=$(""+id).value.trim(); if(v) basket.push(v.toUpperCase()); });
  }
  return {
    ticker:$("ticker").value, basket:!single && basket.length>=2,
    basketList:basket,
    tenor:+$("tenor").value, issue:$("issue").value, lockout:+$("lockout").value,
    call:+$("call").value, mb:+$("mb").value,
    callable:$("callable").value, cfreq:$("cfreq").value,
    notional:+$("notional").value, ccy:$("ccy").value,
    coupon:$("coupon").value===""?null:+$("coupon").value,
    put:$("put").value===""?null:+$("put").value
  };
}

async function runAll(){
  $("err").style.display="none";
  const p=readParams();
  if(!p.tenor||p.tenor<1){$("err").style.display="block";$("err").textContent="Tenor ≥ 1";return;}
  // Solve-target validation: exactly ONE of coupon / put must be blank (red text, no popup)
  const hasC=p.coupon!=null, hasP=p.put!=null;
  if(!hasC && !hasP){
    const m={tc:"請輸入 Client Coupon 或 Put/Strike 其中一項（留空另一項，系統自動求解）。",
             sc:"请输入 Client Coupon 或 Put/Strike 其中一项（留空另一项，系统自动求解）。",
             en:"Please enter EITHER Client Coupon OR Put/Strike (leave the other blank to auto-solve)."};
    $("err").style.display="block";$("err").textContent=(m[LANG]||m.tc);
    return;
  }
  if(hasC && hasP){
    // Manual / term-sheet mode: both strike% and coupon% entered → use EXACTLY as given
    // (like a FinIQ quotation). Skip the solver; graph + scenario show the entered scenario.
    p.manual = true;
  } else {
    p.manual = false;
  }
  $("tickerName").textContent="→ "+tickerName(p.ticker);
  if(p.basket) BASKET=p.basketList.slice();   // update BASKET BEFORE loadChart so multi-chart renders
  await loadChart(CUR.range||"6mo");
  await loadIV();
  recompute();
}

// ---------- chart (single + basket dual/triple) ----------
async function loadChart(range){
  const p=readParams();
  const tickers = (p.basket && BASKET.length>=2) ? BASKET : [p.ticker];
  const all=await Promise.all(tickers.map(t=>fetchCandles(t,range).catch(()=>({data:sampleCandles(132),source:"sample",provider:"sample"}))));
  CUR.spot = all[0].data.length ? all[0].data[all[0].data.length-1].close : 0;
  renderCharts(tickers, all);
}

function newChart(el){
  const chart=LightweightCharts.createChart(el,{
    layout:{background:{color:"#ffffff"},textColor:"#1a2540"},
    grid:{vertLines:{color:"#eceff5"},horzLines:{color:"#eceff5"}},
    rightPriceScale:{borderColor:"#d0d8e5"},timeScale:{borderColor:"#d0d8e5",rightOffset:0,fixLeftEdge:false},crosshair:{mode:1}});
  const series=chart.addCandlestickSeries({upColor:"rgba(196,24,24,0)",downColor:"#099960",
    borderUpColor:"#c41818",borderDownColor:"#099960",wickUpColor:"#c41818",wickDownColor:"#099960"});
  const maSeries=chart.addLineSeries({color:"#8a6d1f",lineWidth:2,priceLineVisible:false,lastValueVisible:true,
    title:"MA"});
  const c={chart,series,maSeries,_call:null,_put:null,_spot:0,_tt:null,_lvlNote:null,_data:null};
  chart.subscribeCrosshairMove(param=>onHover(param,c,el));
  return c;
}

function renderCharts(tickers, all){
  const wrap=$("chart");
  CHARTS.forEach(c=>{try{c.chart.remove();}catch(e){}});
  CHARTS=[];
  wrap.innerHTML="";
  const n=tickers.length;
  wrap.style.gridTemplateColumns = n>=3 ? "1fr 1fr 1fr" : (n===2 ? "1fr 1fr" : "1fr");
  tickers.forEach((t,i)=>{
    const box=document.createElement("div");box.className="subchart";
    const cap=document.createElement("div");cap.className="subcap";
    const src=all[i].source==="sample"
      ? '<span style="color:#d97706">[SAMPLE 假數據]</span>'
      : '<span style="color:#099960">● 真實數據：'+all[i].provider+'</span>';
    cap.innerHTML=`<b>${t}</b> · ${tickerName(t)} <span style="font-size:11px">${src}</span>`;
    const el=document.createElement("div");el.className="subel";el.style.height="300px";el.style.position="relative";
    const tt=document.createElement("div");tt.className="cht-tt";tt.style.display="none";
    const lvlNote=document.createElement("div");lvlNote.className="lvlnote";
    box.appendChild(cap);box.appendChild(el);el.appendChild(tt);box.appendChild(lvlNote);wrap.appendChild(box);
    const c=newChart(el);
    c._spot = all[i].data.length ? all[i].data[all[i].data.length-1].close : 0;
    c._tt = tt; c._lvlNote = lvlNote; c._data = all[i].data;
    c._tk = t;   // store ticker for JPG export per-chart labels
    c.series.setData(all[i].data);
    c.chart.timeScale().fitContent();
    c.chart.timeScale().scrollToRealTime();   // 最後一支燭貼右邊，唔好被 whitespace 切走（否則看似停喺前一交易日）
    CHARTS.push(c);
  });
  drawLevelsAll();
  applySMAAll();
}

function onHover(param,c,el){
  const tt=c._tt; if(!tt)return;
  if(!param.time||!param.point){tt.style.display="none";return;}
  const d=param.seriesData.get(c.series);
  if(!d){tt.style.display="none";return;}
  const up=d.close>=d.open;
  tt.innerHTML=`<b>${param.time}</b><br>開 ${fmt(d.open)} · 高 ${fmt(d.high)}<br>低 ${fmt(d.low)} · 收 ${fmt(d.close)} `+
    `<span style="color:${up?'#c41818':'#099960'}">${up?'▲':'▼'}${fmt(d.close-d.open)}</span>`;
  tt.style.display="block";
  const w=el.getBoundingClientRect();
  let x=param.point.x+16, y=param.point.y+12;
  if(x>w.width-170)x=param.point.x-180;
  if(y>w.height-90)y=param.point.y-90;
  tt.style.left=x+"px"; tt.style.top=y+"px";
}

// per-chart call/put lines using EACH chart's own spot (fixes scale mismatch)
function drawLevelsAll(){ CHARTS.forEach(drawLevelsOn); }
function drawLevelsOn(c){
  if(!c||!c.chart)return;
  if(c._call)c.series.removePriceLine(c._call);
  if(c._put)c.series.removePriceLine(c._put);
  if(c._be)c.series.removePriceLine(c._be);
  if(!c._spot||!CUR.call||!CUR.put)return;
  const putPx=c._spot*CUR.put/100;
  const clTitle = LANG==="en"?`Call ${CUR.call}%`:(LANG==="sc"?`收回 ${CUR.call}%`:`收回 ${CUR.call}%`);
  const ptTitle = LANG==="en"?`Put ${CUR.put}%`:(LANG==="sc"?`行使 ${CUR.put}%`:`行使 ${CUR.put}%`);
  c._call=c.series.createPriceLine({price:c._spot*CUR.call/100,color:"#099960",lineWidth:2,lineStyle:2,axisLabelVisible:true,title:clTitle});
  c._put =c.series.createPriceLine({price:putPx,color:"#c41818",lineWidth:2,lineStyle:2,axisLabelVisible:true,title:ptTitle});
  // breakeven spot (incl. interest) — dashed gold line, only when valid
  if(CUR.bePut && CUR.bePut>0 && CUR.bePut < CUR.put){
    const bePx=c._spot*CUR.bePut/100;
    c._be=c.series.createPriceLine({price:bePx,color:"#8a6d1f",lineWidth:2,lineStyle:2,axisLabelVisible:true,title:`BE ${CUR.bePut.toFixed(1)}%`});
  }
  // Put level ≈ historical level note (formal, localized)
  if(c._lvlNote){
    const ds=c._data||[];
    let hit=null;
    for(let i=ds.length-1;i>=0;i--){ if(ds[i].low!=null && ds[i].low<=putPx){hit=ds[i];break;} }
    if(hit){
      const dHit=new Date(hit.time), now=new Date();
      const months=Math.max(0,Math.round((now-dHit)/(30.44*864e5)));
      const yrs=(months/12).toFixed(1);
      const ago = LANG==="en" ? (months>=12?`${yrs} years ago`:`${months} months ago`)
                : LANG==="sc" ? (months>=12?`约 ${yrs} 年前`:`约 ${months} 个月前`)
                : (months>=12?`約 ${yrs} 年前`:`約 ${months} 個月前`);
      c._lvlNote.innerHTML = LANG==="en"
        ? `🔻 Put level ${CUR.put}% ≈ <b class="hl">${fmt(putPx)}</b>, corresponding to the price level last seen on <b class="hl">${hit.time}</b> (${ago}).`
        : LANG==="sc"
        ? `🔻 行使价 ${CUR.put}% ≈ <b class="hl">${fmt(putPx)}</b>，相当于 <b class="hl">${hit.time}</b>（${ago}）之价格水平。`
        : `🔻 行使價 ${CUR.put}% ≈ <b class="hl">${fmt(putPx)}</b>，相當於 <b class="hl">${hit.time}</b>（${ago}）之價格水平。`;
    }else{
      c._lvlNote.innerHTML = LANG==="en"
        ? `🔻 Put level ${CUR.put}% ≈ <b class="hl">${fmt(putPx)}</b> — not reached within the displayed range; select 3Y / 5Y / 10Y to view longer history.`
        : LANG==="sc"
        ? `🔻 行使价 ${CUR.put}% ≈ <b class="hl">${fmt(putPx)}</b>，于显示范围内未曾触及；可选 3Y / 5Y / 10Y 查看较长历史。`
        : `🔻 行使價 ${CUR.put}% ≈ <b class="hl">${fmt(putPx)}</b>，於顯示範圍內未曾觸及；可選 3Y / 5Y / 10Y 查看較長歷史。`;
    }
  }
}

// REAL moving average as a line series (not a flat price line)
function applySMAAll(){ CHARTS.forEach(applySMAOn); }
function applySMAOn(c){
  if(!c||!c.chart)return;
  c.maSeries.setData([]);
  if(!SMA_ON)return;
  SMA_N=+$("smaN").value||10;
  const ds=c.series.data(); if(!ds||ds.length<SMA_N)return;
  const vals=ds.map(d=>d.close);
  const maData=ds.map((d,i)=>{
    if(i<SMA_N-1)return null;
    let s=0;for(let k=0;k<SMA_N;k++)s+=vals[i-k];
    return {time:d.time,value:+(s/SMA_N).toFixed(2)};
  }).filter(Boolean);
  if(maData.length)c.maSeries.setData(maData);
}

// ---------- IV ----------
async function loadIV(){
  const p=readParams();
  const strikeGuess=p.call||90;
  BASKET_IV=[];
  if(p.basket && BASKET.length>=2){
    // basket: fetch IV for EVERY component
    const results=await Promise.all(BASKET.map(s=>fetchIV(s,p.tenor,strikeGuess).catch(()=>null)));
    BASKET_IV=results.map((r,i)=>({sym:BASKET[i],ivK:r?r.atStrike:null,ivA:r?r.atm:null,src:r?r.source:"none",expiry:r?r.expiry:null,spot:r?r.spot:null,strikeUsed:r?r.strikeUsed:null})).filter(x=>x.ivK!=null);
    // pricing driver = highest-vol component (worst-of); real sources = live/worker_auto/bloomberg*
    const isRealSrc = x => ["live","worker_auto","bloomberg","bloomberg_fallback","bloomberg_offline","cboe_atm_iv"].includes(x.src);
    const live=BASKET_IV.filter(isRealSrc);
    const drv=(live.length?live:BASKET_IV).slice().sort((a,b)=>b.ivK-a.ivK)[0];
    LAST_IV = drv ? {atm:drv.ivA,atStrike:drv.ivK,spot:drv.spot,source:drv.src,expiry:drv.expiry,strikeUsed:drv.strikeUsed} : {atm:0.5,atStrike:0.6,source:"sample"};
    renderBasketIV(BASKET_IV, drv);
  } else {
    const iv=await fetchIV(p.ticker,p.tenor,strikeGuess);
    LAST_IV=iv;
    if(iv.spot)CUR.spot=iv.spot;
    renderBanks(iv);
  }
}

// basket mode: one IV card PER component (real per-stock IV, not bank-seeded)
function renderBasketIV(list, drv){
  const box=$("banks");box.innerHTML="";
  list.forEach(x=>{
    const isDrv = drv && x.sym===drv.sym;
    const el=document.createElement("div");el.className="bank"+(isDrv?" drv":"");
    const isRealSrc = ["live","worker_auto","bloomberg","bloomberg_fallback","bloomberg_offline","cboe_atm_iv"].includes(x.src);
    const srcLabel = x.src==="auto" ? ("auto "+(x.autoWindow||"90d"))
                   : x.src==="live" ? ("live · "+(x.expiry||""))
                   : x.src==="worker_auto" ? "auto · Yahoo 3M ATM"
                   : x.src==="cboe_atm_iv" ? "CBOE ATM IV"
                   : x.src==="bloomberg" ? "Bloomberg · 3M 100%-mn"
                   : x.src==="bloomberg_fallback" ? "Bloomberg (fallback)"
                   : x.src==="bloomberg_offline" ? "Bloomberg (offline)"
                   : "sample";
    el.innerHTML=`<div class="n">${x.sym}${isDrv?" ★":""}</div><div class="iv">${pct(x.ivA*100,1)}</div>`
      +`<div class="m">ATM IV · strike IV ${pct(x.ivK*100,1)}</div>`
      +`<div class="st ${isRealSrc?'live':'samp'}">${srcLabel}</div>`;
    box.appendChild(el);
  });
  if(!list.length){
    box.innerHTML='<div class="bank samp">—</div>';
  }
  const names=list.map(x=>`${x.sym} ${pct(x.ivA*100,1)}`).join(" · ");
  let note;
  if(LANG==="en"){
    note=`✅ Real per-stock IV (auto-updated): ${names}. Worst-of pricing is driven by <b>${drv?drv.sym:"—"}</b> (highest IV).`;
  }else if(LANG==="sc"){
    note=`✅ 篮子内各股真实 IV（自动更新）：${names}。Worst-of 定价由 <b>${drv?drv.sym:"—"}</b>（最高 IV）主导。`;
  }else{
    note=`✅ 籃子內各股真實 IV（自動更新）：${names}。Worst-of 定價由 <b>${drv?drv.sym:"—"}</b>（最高 IV）主導。`;
  }
  const anySample=list.some(x=>!["live","worker_auto","bloomberg","bloomberg_fallback","bloomberg_offline","auto"].includes(x.src));
  if(anySample){
    note += LANG==="en" ? " ⚠ Components without live/auto IV use calibrated table pricing."
         : LANG==="sc" ? " ⚠ 无 live/auto IV 之成分股以校准表定价。"
         : " ⚠ 無 live/auto IV 之成分股以校準表定價。";
  }
  $("ivNote").innerHTML=note;
}

function renderBanks(iv){
  const box=$("banks");box.innerHTML="";
  const banks=["HSBC","JPM","BNP","UBS","SG","Barclays"];
  const seeds={HSBC:1.0,JPM:0.98,BNP:1.05,UBS:1.02,SG:1.08,Barclays:1.03};
  const base=iv.atm||0.5;
  const isReal = iv.source==='live'||iv.source==='bloomberg'||iv.source==='worker_auto'||iv.source==='bloomberg_fallback'||iv.source==='bloomberg_offline'||iv.source==='cboe_atm_iv';
  const srcClass = isReal ? 'live' : 'samp';
  const srcLabel = iv.source==='live' ? ('live · '+(iv.expiry||''))
                 : iv.source==='worker_auto' ? ('auto · Yahoo 3M ATM'+(iv.expiry||''))
                 : iv.source==='cboe_atm_iv' ? ('CBOE '+(iv.expiry||'ATM')+' IV'+(iv.as_of?' · '+iv.as_of:''))
                 : iv.source==='bloomberg_fallback' ? ('Bloomberg (fallback) · 3M 100%-mn')
                 : iv.source==='bloomberg' ? ('Bloomberg · '+(iv.expiry||''))
                 : iv.source==='bloomberg_offline' ? ('Bloomberg (offline) · 3M 100%-mn')
                 : 'sample (seeded)';
  banks.forEach(b=>{
    const v=base*seeds[b]*(0.98+Math.random()*0.04);
    const el=document.createElement("div");el.className="bank";
    el.innerHTML=`<div class="n">${b}</div><div class="iv">${pct(v*100,1)}</div>`
      +`<div class="m">ATM IV</div><div class="st ${srcClass}">${srcLabel}</div>`;
    box.appendChild(el);
  });
  const atm=pct(iv.atm*100,1), stk=pct((iv.strikeUsed&&CUR.spot)?iv.strikeUsed/CUR.spot*100:0,0), stkiv=pct(iv.atStrike*100,1), exp=iv.expiry||"";
  let note;
  const isBB = iv.source==="bloomberg"||iv.source==="bloomberg_fallback"||iv.source==="bloomberg_offline";
  if(isBB){
    const tag = iv.source==="bloomberg_fallback" ? "Bloomberg (fallback · Yahoo 0/NA)" : iv.source==="bloomberg_offline" ? "Bloomberg (offline 後備)" : "Bloomberg";
    note = (LANG==="en")
      ? `✅ ${tag} 3M 100%-moneyness IV · ATM ≈ <b>${atm}</b> · strike(${stk}) IV ≈ <b>${stkiv}</b>. Bank rows are indicative (spread-adjusted).`
      : (LANG==="sc")
      ? `✅ ${tag} 3个月 100% 价外 IV · ATM ≈ <b>${atm}</b> · strike(${stk}) IV ≈ <b>${stkiv}</b>。各行均为按惯例 spread 调整的 indicative。`
      : `✅ ${tag} 3個月 100%-moneyness IV · ATM ≈ <b>${atm}</b> · strike(${stk}) IV ≈ <b>${stkiv}</b>。各行均為按慣例 spread 調整之 indicative。`;
  } else if(iv.source==="cboe_atm_iv"){
    const tlabel = (iv.expiry||"ATM")+" ATM";
    note = (LANG==="en")
      ? `✅ Auto IV (CBOE ${tlabel} implied vol, key-free) · ATM ≈ <b>${atm}</b> · strike(${stk}) IV ≈ <b>${stkiv}</b>${iv.as_of?' · as of '+iv.as_of:''}. Bank rows are indicative (spread-adjusted).`
      : (LANG==="sc")
      ? `✅ 自动 IV（CBOE ${tlabel} 隐含波动率，免密钥）· ATM ≈ <b>${atm}</b> · strike(${stk}) IV ≈ <b>${stkiv}</b>${iv.as_of?' · 截至 '+iv.as_of:''}。各行均为按惯例 spread 调整的 indicative。`
      : `✅ 自動 IV（CBOE ${tlabel} implied vol，免 key）· ATM ≈ <b>${atm}</b> · strike(${stk}) IV ≈ <b>${stkiv}</b>${iv.as_of?' · 截至 '+iv.as_of:''}。各行均為按慣例 spread 調整之 indicative。`;
  } else if(iv.source==="live"){
    note = (LANG==="en")
      ? `✅ Real Option IV (auto-updated via Yahoo) · ATM ≈ <b>${atm}</b> · strike(${stk}) IV ≈ <b>${stkiv}</b> · expiry ${exp}. Bank rows are indicative (spread-adjusted).`
      : (LANG==="sc")
      ? `✅ 真实 Option IV（自动更新）· ATM ≈ <b>${atm}</b> · strike(${stk}) IV ≈ <b>${stkiv}</b> · 到期 ${exp}。各行均为按惯例 spread 调整的 indicative。`
      : `✅ 真實 Option IV（自動更新）· ATM ≈ <b>${atm}</b> · strike(${stk}) IV ≈ <b>${stkiv}</b> · 到期 ${exp}。各行均為按慣例 spread 調整之 indicative。`;
  } else if(iv.source==="auto"){
    note = (LANG==="en")
      ? `✅ Auto IV (90-day realized vol, daily via Yahoo) · ≈ <b>${atm}</b> · window ${iv.autoWindow||"90d"}.`
      : (LANG==="sc")
      ? `✅ 自动 IV（90日 realized vol，每日经 Yahoo 更新）· ≈ <b>${atm}</b> · 窗口 ${iv.autoWindow||"90d"}。`
      : `✅ 自動 IV（90日 realized vol，每日經 Yahoo 更新）· ≈ <b>${atm}</b> · 窗口 ${iv.autoWindow||"90d"}。`;
  } else {
    note = (LANG==="en")
      ? `⚠ Live/auto IV unavailable (rate-limit); showing <b>sample</b>. Refer to bank indicative for actual terms.`
      : (LANG==="sc")
      ? `⚠ 真实 IV 暂取不到（rate-limit），显示 <b>sample</b>。实际以银行 indicative 为准。`
      : `⚠ 真實 IV 暫取不到（rate-limit），顯示 <b>sample</b>。實盤以銀行 indicative 為準。`;
  }
  $("ivNote").innerHTML = note;
}

// ---------- recompute (live IV priority for single stock) ----------
function recompute(){
  const p=readParams();
  if(p.basket) BASKET=p.basketList.slice();
  if(p.basket && BASKET_IV.length>=2) p.basket=BASKET_IV;

  // Determine default coupon (for solve card / defaults) — live IV model
  const defaultCoupon = (()=>{
    const r=solveParams({...p,put:p.put||45,coupon:null}, LAST_IV);
    return r.out.coupon;
  })();

  // ---- PREFER real FinIQ calibration table (baskets + HK) ----
  let calibHit=null;
  const hasCoupon=p.coupon!=null&&p.coupon!==""&&!isNaN(p.coupon);
  const hasPut=p.put!=null&&p.put!==""&&!isNaN(p.put);
  try{
    if(p.basket && BASKET.length>=2){
      // ---- BS (Bloomberg IV, worst-of = highest-IV component) PRIMARY for basket ----
      if(bsBasketDriver(BASKET)){
        if(!hasPut && hasCoupon){const r=calibBsBasketPut(BASKET,p.coupon,p.mb,p.call,p.tenor,p.cfreq); if(r)calibHit={put:+(r.put*callAdj(p.call)).toFixed(2),coupon:p.coupon,src:r.src};}
        else if(!hasCoupon && hasPut){const r=calibBsBasketCoupon(BASKET,p.put,p.mb,p.call,p.tenor,p.cfreq); if(r)calibHit={put:p.put,coupon:r.coupon,src:r.src};}
        else if(!hasCoupon && !hasPut){const r=calibBsBasketPut(BASKET,18,p.mb,p.call,p.tenor,p.cfreq); if(r)calibHit={put:+(r.put*callAdj(p.call)).toFixed(2),coupon:18,src:r.src};}
      }
      if(!calibHit){
      const isUsBk = calibUsBasketPut(BASKET,p.coupon||18,p.mb,p.tenor,p.call)!=null;
      if(isUsBk){
        if(!hasPut && hasCoupon){const r=calibUsBasketPut(BASKET,p.coupon,p.mb,p.tenor,p.call); if(r)calibHit={put:r.put,coupon:p.coupon,src:`FinIQ US basket${r.bank?' ('+r.bank+')':''}`};}
        else if(!hasCoupon && hasPut){const r=calibUsBasketCoupon(BASKET,p.put,p.mb,p.tenor,p.call); if(r)calibHit={put:p.put,coupon:r.coupon,src:"FinIQ US basket"};}
        else if(!hasCoupon && !hasPut){const r=calibUsBasketPut(BASKET,18,p.mb,p.tenor,p.call); if(r)calibHit={put:r.put,coupon:r.quoteCoupon,src:"FinIQ US basket (預設)"};}
      } else {
        // HK basket: exact real-quote table first, then DERIVED from single table (all combos)
        if(!hasPut && hasCoupon){
          let v=calibHkBasketPut(BASKET,p.coupon,p.mb);
          if(v==null)v=calibHkBasketDerivedPut(BASKET,p.coupon,p.mb);
          if(v!=null)calibHit={put:v,coupon:p.coupon,src:"FinIQ HK basket"};
        }
        else if(!hasCoupon && hasPut){
          let v=calibHkBasketCoupon(BASKET,p.put,p.mb);
          if(v==null)v=calibHkBasketDerivedCoupon(BASKET,p.put,p.mb);
          if(v!=null)calibHit={put:p.put,coupon:v,src:"FinIQ HK basket"};
        }
        else if(!hasCoupon && !hasPut){
          let v=calibHkBasketPut(BASKET,10,p.mb);
          if(v==null)v=calibHkBasketDerivedPut(BASKET,10,p.mb);
          if(v!=null)calibHit={put:v,coupon:10,src:"FinIQ HK basket (預設10%)"};
        }
        // HK basket with unknown component — never fall through to the US IV model
        const allHkNum = BASKET.every(s=>/^\d+$/.test(String(s).replace(/\.HK$/i,"").trim()));
        if(!calibHit && allHkNum){
          const m={tc:`籃子內有成分股未有校準報價（現有單頭：992/9992/9988/3690/1211/9999/700/5/2388/388），暫未能定價。請先加入該股之 FinIQ 真實報價。`,
                   sc:`篮子内有成分股未有校准报价，暂未能定价。请先加入该股之 FinIQ 真实报价。`,
                   en:`A basket component has no calibration quote — cannot price. Please add a real FinIQ quote for it first.`};
          $("err").style.display="block";$("err").textContent=(m[LANG]||m.tc);
          return;
        }
      }
      } // end if(!calibHit)
    } else if(isHK(usSym(p.ticker))) {
   // HK single — BS (Bloomberg IV) PRIMARY when IV available + live spot known
   if(bsCalibAvailable(p.ticker)){
     const cA=callAdj(p.call);
     if(!hasPut && hasCoupon){const r=calibBsSinglePut(p.ticker,p.coupon,p.mb,p.call,p.tenor,p.cfreq); if(r)calibHit={put:+(r.put*cA).toFixed(2),coupon:p.coupon,src:r.src};}
     else if(!hasCoupon && hasPut){const r=calibBsSingleCoupon(p.ticker,p.put,p.mb,p.call,p.tenor,p.cfreq); if(r)calibHit={put:p.put,coupon:r.coupon,src:r.src};}
     else if(!hasCoupon && !hasPut){const r=calibBsSinglePut(p.ticker,8,p.mb,p.call,p.tenor,p.cfreq); if(r)calibHit={put:+(r.put*cA).toFixed(2),coupon:8,src:r.src+" (預設8%)"};}
   }
   if(!calibHit){
   // HK single — AUTO IV (90d realized vol) fallback via √IV model.
   const tk=normSym(p.ticker);
   const ref=CALIB.hk_single_ref[tk];
   if(ref!=null && LAST_IV && LAST_IV.atStrike){
     // K = anchor_gross / (anchor_put% * √anchorIV); anchor gross = 8+mb
     const ivK = (LAST_IV.atStrike||LAST_IV.atm||0.4);
     const K = ( (8+p.mb)/100 ) / ( (ref/100) * Math.sqrt(Math.max(ivK,0.05)) );
     const cA = callAdj(p.call);
     const solveFromK=(gross)=> +( (gross/100) / ( Math.sqrt(Math.max(ivK,0.05)) * K * cA ) *100 ).toFixed(2);
     const grossFromPut=(put)=> (put/100)*Math.sqrt(Math.max(ivK,0.05))*K*cA*100;
     if(!hasPut && hasCoupon){
       const g=(p.coupon+p.mb)/100*100; // gross% = coupon+mb
       calibHit={put:solveFromK(p.coupon+p.mb), coupon:p.coupon, src:"Auto IV (√IV)"};
     } else if(!hasCoupon && hasPut){
       const g=grossFromPut(p.put);
       calibHit={put:p.put, coupon:+(g-p.mb).toFixed(2), src:"Auto IV (√IV)"};
     } else if(!hasCoupon && !hasPut){
       calibHit={put:solveFromK(10+p.mb), coupon:10, src:"Auto IV (√IV) 預設10%"};
     }
   }
   // fallback: static table (if auto IV unavailable)
   if(!calibHit){
     if(!hasPut && hasCoupon){const v=calibHkSinglePut(p.ticker,p.coupon,p.mb); if(v!=null)calibHit={put:v,coupon:p.coupon,src:"FinIQ HK single table"};}
     else if(!hasCoupon && hasPut){const v=calibHkSingleCoupon(p.ticker,p.put,p.mb); if(v!=null)calibHit={put:p.put,coupon:v,src:"FinIQ HK single table"};}
     else if(!hasCoupon && !hasPut){const v=calibHkSinglePut(p.ticker,10,p.mb); if(v!=null)calibHit={put:v,coupon:10,src:"FinIQ HK single (預設10%)"};}
   }
   if(!calibHit){
     const m={tc:`0${p.ticker} 未有校準報價，暫未能定價。請先於 FinIQ 取一個真實報價加入校準表（現有：992/9992/9988/3690/1211/9999/700/5/2388/388）。`,
              sc:`0${p.ticker} 未有校准报价，暂未能定价。请先于 FinIQ 取一个真实报价加入校准表。`,
              en:`No calibration quote for ${p.ticker}.HK — cannot price. Please add a real FinIQ quote to the calibration table first.`};
     $("err").style.display="block";$("err").textContent=(m[LANG]||m.tc);
     return;
   }
   }
 }
    else {
      // ---- US single: FinIQ linear calibration PRIMARY for calibrated stocks (SNDK/DRAM) ----
      // NOTE: FinIQ model already encodes the call & MB & freq effects — do NOT apply callAdj on top.
      const tk=normSym(p.ticker);
      const fiRaw=(typeof finiqPut!=='undefined')?finiqPut(tk,p.call,p.mb,p.cfreq):null;
      if(fiRaw!=null){
        if(p.tenor>=24){ // 24M excluded from FinIQ fit → no quotation
          calibHit={put:null,coupon:hasCoupon?p.coupon:null,src:"FinIQ (no quotation @24M)",noQuote:true};
        } else if(fiRaw<40){ // FinIQ floor: sub-40% strikes are not quoted
          calibHit={put:null,coupon:hasCoupon?p.coupon:null,src:"FinIQ (<40% no quotation)",noQuote:true};
        } else {
          const fiPut=Math.min(99,Math.max(40,fiRaw));
          if(!hasPut && hasCoupon){ calibHit={put:+fiPut.toFixed(2), coupon:p.coupon, src:"FinIQ linear (SNDK/DRAM)"}; }
          else if(!hasCoupon && hasPut){
            // invert FinIQ to get coupon: treat put as fixed, solve coupon by scanning
            const c=FINIQ_COEF[tk]; const L=FINIQ_LOCK[String(p.cfreq).toLowerCase()]||1;
            const fo=L===2?c.FO2:L===3?c.FO3:L===6?c.FO6:L===12?c.FO12:0;
            const d=Math.max(0,(90-p.call)/10); const g=d*d;
            // fiRaw(KM, KX depend on mb) — for coupon solve keep mb fixed, rearrange:
            // put = b0+fo+KC*g + KM*(mb-1)+KX*(mb-1)*g  (put independent of coupon in this model)
            // => cannot solve coupon from put uniquely without MB; use BS inverse for coupon instead.
            const r=calibBsSingleCoupon(tk,p.put,p.mb,p.call,p.tenor,p.cfreq);
            if(r) calibHit={put:p.put,coupon:r.coupon,src:r.src};
          }
          else if(!hasCoupon && !hasPut){ calibHit={put:+fiPut.toFixed(2), coupon:8, src:"FinIQ linear (SNDK/DRAM) 預設8%"}; }
        }
      }
      if(!calibHit){
      // ---- US single: BS (Bloomberg IV) PRIMARY, then FinIQ table, then live IV model ----
      const cA=callAdj(p.call);
      if(bsCalibAvailable(p.ticker)){
        if(!hasPut && hasCoupon){const r=calibBsSinglePut(p.ticker,p.coupon,p.mb,p.call,p.tenor,p.cfreq); if(r)calibHit={put:+(r.put*cA).toFixed(2),coupon:p.coupon,src:r.src};}
        else if(!hasCoupon && hasPut){const r=calibBsSingleCoupon(p.ticker,p.put,p.mb,p.call,p.tenor,p.cfreq); if(r)calibHit={put:p.put,coupon:r.coupon,src:r.src};}
        else if(!hasCoupon && !hasPut){const r=calibBsSinglePut(p.ticker,8,p.mb,p.call,p.tenor,p.cfreq); if(r)calibHit={put:+(r.put*cA).toFixed(2),coupon:8,src:r.src+" (預設8%)"};}
      }
      if(!calibHit){
        if(!hasPut && hasCoupon){
          const v=calibUsPut(p.ticker,p.coupon,p.mb);
          if(v!=null)calibHit={put:+(v*cA).toFixed(2),coupon:p.coupon,src:"FinIQ US single table"};
        } else if(!hasCoupon && hasPut){
          const v=calibUsCoupon(p.ticker,p.put/cA,p.mb);
          if(v!=null)calibHit={put:p.put,coupon:v,src:"FinIQ US single table"};
        } else if(!hasCoupon && !hasPut){
          const v=calibUsPut(p.ticker,8,p.mb);
          if(v!=null)calibHit={put:+(v*cA).toFixed(2),coupon:8,src:"FinIQ US single (預設8%)"};
        }
      }
      } // end FinIQ-fallback BS block
      // not in any calib → fall through to live IV model (solveParams)
    }
  }catch(e){}
  // ---- Manual / term-sheet mode: both strike% & coupon% entered → use EXACTLY as given ----
  // Applied AFTER the solver so it always wins; skip FinIQ sanity caps below.
  if(p.manual){
    calibHit = {put:+p.put, coupon:+p.coupon, src:"Manual term-sheet", manual:true};
  }

  // ---- HK sanity cap: HK singles/baskets never price below 50% strike ----
  // (skipped entirely in manual term-sheet mode — user enters the exact deal)
  if(calibHit && !calibHit.manual){
    const hkDeal = (p.basket && BASKET.length>=2 && BASKET.every(s=>/^\d+$/.test(String(s).replace(/\.HK$/i,"").trim())))
                 || (!p.basket && isHK(usSym(p.ticker)));
    if(hkDeal && calibHit.put!=null && calibHit.put<50){
      const m={tc:`⚠ 此條款組合超出港股常見範圍（計得 strike ${calibHit.put}% < 50%）。港股單頭 8–10% coupon 一般為 6x–9x 折。請調低 coupon 或 MB。`,
               sc:`⚠ 此条款组合超出港股常见范围（计得 strike ${calibHit.put}% < 50%）。请调低 coupon 或 MB。`,
               en:`⚠ Terms outside normal HK range (computed strike ${calibHit.put}% < 50%). Lower the coupon or MB.`};
      $("err").style.display="block";$("err").textContent=(m[LANG]||m.tc);
    }
    if(calibHit.put!=null && calibHit.put>95){
      const m={tc:`⚠ 計得 strike ${calibHit.put}% 已高於 95%——此 coupon/MB 組合對該股而言過高（vol 不足以支持），實盤多數做唔到。請調低 coupon 或 MB。`,
               sc:`⚠ 计得 strike ${calibHit.put}% 已高于 95%——此 coupon/MB 组合过高，实盘多数做不到。请调低 coupon 或 MB。`,
               en:`⚠ Computed strike ${calibHit.put}% exceeds 95% — this coupon/MB combination is too rich for this stock's vol; unlikely to be dealable. Lower the coupon or MB.`};
      $("err").style.display="block";$("err").textContent=(m[LANG]||m.tc);
      calibHit.put=Math.min(calibHit.put,99);
    }
    // ---- RM min-coupon rule: client coupon cannot be below (12/tenor)*MB% (RM cannot eat more than client) ----
    if(calibHit.coupon!=null){
      const minC = bsMinCoupon(p.tenor, p.mb);
      if(calibHit.coupon < minC - 1e-6){
        const m={tc:`⚠ 客戶票息低於最低要求：本結構最低票息須為 ${pct(minC)}（計算基準：12 ÷ ${p.tenor}個月 × MB ${pct(p.mb)}）。現計得 ${pct(calibHit.coupon)}，低於下限，RM 不可收取多於客戶之收益。請上調票息或下調 MB，否則此交易不可行。`,
                 sc:`⚠ 客户票息低于最低要求：本结构最低票息须为 ${pct(minC)}（计算基准：12 ÷ ${p.tenor}个月 × MB ${pct(p.mb)}）。现计得 ${pct(calibHit.coupon)}，低于下限，RM 不可收取多于客户之收益。请上调票息或下调 MB，否则此交易不可行。`,
                 en:`⚠ Client coupon below the minimum required: the minimum coupon for this structure is ${pct(minC)} (basis: 12 ÷ ${p.tenor} months × MB ${pct(p.mb)}). The computed ${pct(calibHit.coupon)} is below the floor — the RM cannot retain more than the client's yield. Raise the coupon or lower the MB, otherwise the trade is not viable.`};
        $("err").style.display="block";$("err").textContent=(m[LANG]||m.tc);
      }
    }
    // ---- Non-call (lock-out) period cannot exceed tenor ----
    // non-call months derived from coupon frequency: monthly=1, bi-monthly=2, quarterly=3, semi=6, annual=12
    const NC_MAP = { monthly:1, bi:2, bimonthly:2, quarterly:3, semi:6, annual:12 };
    const nonCall = NC_MAP[String(p.cfreq).toLowerCase()] || 1;
    if(nonCall > p.tenor + 1e-9){
      const m={tc:`⚠ 禁 Call 期（${nonCall} 個月）不可長於 Tenor（${p.tenor} 個月）。請縮短禁 Call 期或延長 Tenor。`,
               sc:`⚠ 禁 Call 期（${nonCall} 个月）不可长于 Tenor（${p.tenor} 个月）。请缩短禁 Call 期或延长 Tenor。`,
               en:`⚠ The non-call period (${nonCall} months) cannot exceed the tenor (${p.tenor} months). Shorten the non-call period or extend the tenor.`};
      $("err").style.display="block";$("err").textContent=(m[LANG]||m.tc);
    }
    // ---- <40% floor: FinIQ does not quote strikes below 40% ----
    if(calibHit.noQuote){
      const m={tc:`⚠ 此條款組合 FinIQ 未有報價（計得行使價低於 40% 或該 Tenor 不適用），不應以低於 40% strike 視作可成交。請調整條款（如提高 coupon / 降低 MB / 縮短禁 Call 期）。`,
               sc:`⚠ 此条款组合 FinIQ 未有报价（计得行使价低于 40% 或该 Tenor 不适用），不应以低于 40% strike 视作可成交。请调整条款（如提高 coupon / 降低 MB / 缩短禁 Call 期）。`,
               en:`⚠ No FinIQ quote for this combination (computed strike < 40% or tenor not applicable). Strikes below 40% are not quoted — adjust terms (raise coupon / lower MB / shorten non-call).`};
      $("err").style.display="block";$("err").textContent=(m[LANG]||m.tc);
    } else if(calibHit.put!=null && calibHit.put<40){
      const m={tc:`⚠ 計得行使價 ${calibHit.put}% 低於 40%——FinIQ 不會以此低 strike 報價，實盤不可行。請調高 coupon 或降低 MB。`,
               sc:`⚠ 计得行使价 ${calibHit.put}% 低于 40%——FinIQ 不会以此低 strike 报价，实盘不可行。请调高 coupon 或降低 MB。`,
               en:`⚠ Computed strike ${calibHit.put}% is below 40% — FinIQ does not quote strikes this low; not dealable. Raise the coupon or lower the MB.`};
      $("err").style.display="block";$("err").textContent=(m[LANG]||m.tc);
      calibHit.put=null;
    }
  }

  let out,solved;
  if(calibHit){
    out={...p,coupon:calibHit.coupon,put:calibHit.put,gross:+(calibHit.coupon+p.mb).toFixed(2),basketAdj:1};
    solved={which:(hasCoupon&&!hasPut)?"put":(hasPut&&!hasCoupon)?"coupon":"both",
      note:`${T("cCoupon")} ${pct(calibHit.coupon)} · ${T("cPut")} ${pct(calibHit.put)}`};
    if(calibHit.manual){
      solved.which="manual";
      solved.note = (LANG==="en"?"Manual term-sheet (exact scenario): ":LANG==="sc"?"手动条款（精确情景）：":"手動 term-sheet（精確情景）：")
        + `${T("cCoupon")} ${pct(calibHit.coupon)} · ${T("cPut")} ${pct(calibHit.put)} · ${T("cCall")} ${pct(p.call)}`;
    }
  } else {
    // live IV model (US single primary; also HK fallback)
    const r=solveParams(p,LAST_IV); out=r.out; solved=r.solved;
    solved.note=T("srcEst")+"<br>"+solved.note;
  }
  // solve card
  const sc=$("solveCard");sc.style.display="block";
  let title,val;
  if(solved.which==="both"){title="Coupon + Put";val=`${pct(out.coupon)} / ${pct(out.put)}`;}
  else if(solved.which==="coupon"){title="Client Coupon % p.a.";val=pct(out.coupon);}
  else if(solved.which==="put"){title="Put / Strike Level %";val=pct(out.put);}
  else{title="✓ 全部輸入（gross check）";val=`gross ${pct(out.gross)}`;}
  $("solveLbl").textContent=title;$("solveVal").textContent=val;
  $("solveNote").innerHTML=solved.note;
  // chart lines
  CUR.call=p.call;CUR.put=out.put;
  drawLevelsAll();
  // scenarios
  const S=buildScenarios({...out,tenor:p.tenor,cfreq:p.cfreq,notional:p.notional,ccy:p.ccy,spot:CUR.spot,issue:p.issue,lockout:p.lockout});
  CUR.bePut = S.bePct; CUR.beSpot = S.beSpot;
  renderScenarios(S,p,out);
}

function renderScenarios(S,p,out){
  const tb=$("scnBody");tb.innerHTML="";
  const cpA=out.coupon/100;
  const rows=[
    {t:T("sc1"),called:T("yes"),cpn:sym(p.ccy)+fmt(S.cpnByFirstObs,0),
     prin:T("prinBack"),ret:"+"+pct(cpA*(S.firstObsMonths/12)*100),cls:"good"},
    {t:T("sc2"),called:T("yes"),cpn:T("sc2formula"),
     prin:T("prinBack"),ret:"+"+sym(p.ccy)+fmt(S.cpnByFirstObs,0),cls:"good"},
    {t:T("sc3"),called:T("yes"),cpn:sym(p.ccy)+fmt(S.totalCpnIfHeld,0),
     prin:T("prinBack"),ret:"+"+pct(cpA*(p.tenor/12)*100),cls:"good"},
    {t:T("sc4"),called:T("no"),cpn:sym(p.ccy)+fmt(S.totalCpnIfHeld,0),
     prin:T("takeDelivery"),
     ret:T("belowStrikeLoss"),cls:"bad"}
  ];
  rows.forEach(r=>{const tr=document.createElement("tr");if(r.cls==="good")tr.className="hi";
    tr.innerHTML=`<td class="scn"><span class="t">${r.t}</span></td><td>${r.called}</td>`
      +`<td class="num">${r.cpn}</td><td>${r.prin}</td>`
      +`<td class="scn"><span class="${r.cls}">${r.ret}</span></td>`;
    tb.appendChild(tr);});

  // ---- detail block (client-facing, formal, NO MB) ----
  const strikePx=S.strikePx, shares=S.shares;
  const notional=p.notional, ccy=sym(p.ccy);
  let worstName=p.ticker;
  if(p.basket && BASKET.length>=2) worstName=T("worstPerformer");
  const feeRate=0.0025;
  const deliveryVal=shares*strikePx;
  const fee=deliveryVal*feeRate;
  const wholeShares=Math.floor(shares);
  const fracCash=(shares-wholeShares)*strikePx;
  const remainCash=fracCash - fee;
  // highlight values
  const hl=s=>`<b class="hl">${s}</b>`;
  const kv=(k,v)=>`<div class="kvl">${k}</div><div class="kvv">${v}</div>`;
  let html=`<div class="scnhead">${T("scnDetailTitle")}</div>`;
  html+=`<div class="kv">`;
  html+=kv(T("perCpnLine"),`${hl(ccy+fmt(S.perCpn,0))} <span class="mut">(${T("cCoupon")} ${pct(out.coupon)} p.a.)</span>`);
  html+=kv(T("maxTotalLine"),hl(ccy+fmt(S.totalCpnIfHeld,0)));
  html+=`</div>`;
  html+=`<div class="kv">`;
  html+=kv(T("obsLine"), p.callable==="daily"
      ? T("dailyObs").replace("{m}",S.firstObsMonths)
      : T("periodObs"));
  html+=`</div>`;
  html+=`<div class="scnhead2">${T("deliveryTitle")}</div>`;
  html+=`<div class="kv">`;
  html+=kv(T("deliveryStrike"),`${hl(pct(out.put))} <span class="mut">(${hl(ccy+fmt(strikePx,2))})</span>`);
  html+=kv(T("deliveryWorst"),hl(worstName));
  html+=kv(T("deliveryShares"),`${hl(fmt(wholeShares,0))} <span class="mut">${T("perNotional").replace("{n}",ccy+fmt(notional,0))}</span>`);
  html+=kv(T("deliveryFee"),hl(ccy+fmt(fee,2)));
  html+=kv(T("deliveryCashLbl"),hl(ccy+fmt(Math.max(0,remainCash),2)));
  html+=`</div>`;
  // ---- Breakeven spot (incl. interest earned), assuming delivery at maturity ----
  if(S.beSpot>0 && S.bePct>0){
    const bePx=ccy+fmt(S.beSpot,2);
    html+=`<div class="scnhead2">${T("beTitle")||"Breakeven (接貨 scenario)"}</div>`;
    html+=`<div class="kv">`;
    html+=kv(T("beLevel"),`${hl(pct(S.bePct,1))} <span class="mut">(${hl(bePx)})</span>`);
    html+=`</div>`;
  }
  html+=`<p class="warn">${T("deliveryRisk")}</p>`;
  $("scnDetail").innerHTML=html;
}

// ---- init ----
function init(){
  const dl=$("tickers");UNIVERSE.forEach(u=>{const o=document.createElement("option");o.value=u[0];o.label=u[2];dl.appendChild(o);});
  applyLang();
  // tab switching
  document.querySelectorAll(".tab").forEach(t=>t.onclick=()=>{
    const mode=t.dataset.mode;
    document.querySelectorAll(".tab").forEach(x=>x.classList.toggle("on",x===t));
    $("singlePane").style.display = mode==="single"?"block":"none";
    $("basketPane").style.display = mode==="basket"?"block":"none";
    if(CUR.spot)runAll();
  });
  document.querySelectorAll(".langsw button").forEach(b=>b.onclick=()=>{LANG=b.dataset.l;localStorage.setItem("eln_lang",LANG);applyLang();});
  $("run").onclick=runAll;
  $("reset").onclick=()=>location.reload();
  document.querySelectorAll(".toolbar [data-r]").forEach(b=>b.onclick=()=>{CUR.range=b.dataset.r;loadChart(b.dataset.r).then(recompute);});
  $("smaOn").onchange=e=>{SMA_ON=e.target.checked;applySMAAll();};
  $("smaN").onchange=()=>{ if(SMA_ON)applySMAAll(); };
  $("refresh").onclick=()=>runAll();
  $("saveJpg").onclick=()=>saveSnapshot();
  ["call","mb","coupon","put","cfreq","callable","tenor","notional","lockout","issue","bk1","bk2","bk3"].forEach(id=>
    $(id).addEventListener("input",()=>{if(CUR.spot)recompute();}));
  $("issue").value=new Date().toISOString().slice(0,10);
  // coupon defaults to 10 (from HTML value); put left blank (no default fill)
  setTimeout(runAll,300);
}
window.addEventListener("load",init);

// ---------- Save chart + scenario as JPG (for RM client-facing snapshot) ----------
// Uses lightweight-charts chart.takeScreenshot() which renders the FULL chart
// (candles + price/time axes + call/put price lines + MA overlay) at device resolution.
// This fixes the old export that grabbed only the main series canvas -> blurry + no axes.
function saveSnapshot(){
  const p=readParams();
  const shots = CHARTS.map(c=>{
    try{ return (c.chart && c.chart.takeScreenshot) ? c.chart.takeScreenshot() : null; }catch(e){ return null; }
  }).filter(Boolean);
  if(!shots.length){ toast("Chart not loaded"); return; }

  const W=1800, ML=28, MR=W-28, CW=MR-ML;
  // draw onto a tall offscreen canvas, then crop to the used height (avoids blank clip)
  const tmp=document.createElement("canvas"); tmp.width=W; tmp.height=2600;
  const g=tmp.getContext("2d");
  g.imageSmoothingEnabled=true; g.imageSmoothingQuality="high"; g.textBaseline="alphabetic";
  g.fillStyle="#ffffff"; g.fillRect(0,0,W,tmp.height);

  // --- title bar ---
  const stk=p.basket?BASKET.join(" + "):p.ticker;
  const stkName=p.basket?BASKET.map(tickerName).join(" + "):tickerName(p.ticker);
  g.fillStyle="#8a6d1f"; g.font="bold 28px Arial"; g.textAlign="left";
  g.fillText(`${stk} (${stkName})`,ML,44);
  const cfreqDisp = {monthly:"Monthly",quarterly:"Quarterly",semi:"Semi-Annual",annual:"Annual",bi:"Bi-Monthly",bimonthly:"Bi-Monthly"}[p.cfreq]||p.cfreq;
  const callableTxt = p.callable==="daily" ? `${cfreqDisp} + Daily Close` : `${cfreqDisp} + Period End`;
  const cpnStr = p.coupon ? `${p.coupon}% p.a.` : "—";
  const putStr = p.put!=null ? `${p.put}%` : (sv=>{const m=sv.match(/([\d.]+)\s*%/);return m?`${m[1]}%`:"—";})($("solveVal").textContent);
  // headline: Notional+CCY • Tenor • Coupon • PUT% • CALL% • Freq (all same size, numbers in bronze)
  const fs=20;
  const parts=[
    {t:`${sym(p.ccy)}${fmt(p.notional,0)} ${p.ccy}`,num:true},
    {t:` · `,num:false},
    {t:`${p.tenor}M`,num:true},{t:` Tenor`,num:false},
    {t:` · `,num:false},
    {t:cpnStr,num:true},{t:` Coupon`,num:false},
    {t:` · `,num:false},
    {t:`${putStr} PUT`,num:true},
    {t:` · `,num:false},
    {t:`${p.call}% CALL`,num:true},
    {t:` · ${callableTxt}`,num:false},
  ];
  let hx=ML;
  g.font=`${fs}px Arial`;
  parts.forEach(p2=>{
    g.fillStyle=p2.num?"#8a6d1f":"#3a4a68";
    g.font=p2.num?`bold ${fs}px Arial`:`${fs}px Arial`;
    g.fillText(p2.t,hx,78);
    hx+=g.measureText(p2.t).width;
  });

  // --- Section 1: chart (full screenshot incl. axes) ---
  let y=104;
  g.fillStyle="#3a4a68"; g.font="bold 19px Arial";
  g.fillText(LANG==="en"?"1 · Daily Chart":(LANG==="sc"?"1 · 日线图":"1 · 日線圖"),ML,y); y+=22;
  const chH=640;
  function drawShot(src,x,yy,w,h){
    const sw=src.width, sh=src.height; if(!sw||!sh)return;
    const scale=Math.min(w/sw, h/sh);
    const dw=Math.round(sw*scale), dh=Math.round(sh*scale);
    g.drawImage(src, x+Math.round((w-dw)/2), yy+Math.round((h-dh)/2), dw, dh);
  }
  if(shots.length===1){
    // --- Single chart ---
    const chY=y, c=CHARTS[0];
    drawShot(shots[0],ML,chY,CW,chH);
    if(SMA_ON){ g.textAlign="right"; g.fillStyle="#8a6d1f"; g.font="bold 15px Arial";
      g.fillText(`📈 ${$("smaN").value} SMA`, MR-8, chY+24); g.textAlign="left"; }
    y=chY+chH+24;
    if(c && c._lvlNote && c._lvlNote.innerText.trim()){
      y+=4; g.fillStyle="#3a4a68"; g.font="16px Arial";
      wrapLines(g, c._lvlNote.innerText.replace(/\s+/g," ").trim(), MR-ML).forEach(ln=>{ g.fillText(ln,ML,y); y+=24; });
    }
  } else {
    // --- Basket: per-chart stock name + chart + note ---
    const n=shots.length, gap=12;
    const slotW=Math.floor((CW-gap*(n-1))/n);
    const maxNoteLines=4;  // reserve space; each chart gets its own note block
    // per-chart name label above each chart
    g.font="bold 16px Arial";
    CHARTS.forEach((c,i)=>{
      const x=ML+i*(slotW+gap);
      const tk=c._tk||(p.basket?BASKET[i]:p.ticker);
      const nm=tickerName(tk);
      g.fillStyle="#8a6d1f"; g.textAlign="left";
      g.fillText(`${tk} · ${nm}`, x, y+18);
    });
    y+=28;
    const chY=y;
    shots.forEach((s,i)=>drawShot(s, ML+i*(slotW+gap), chY, slotW, chH));
    if(SMA_ON){ g.textAlign="right"; g.fillStyle="#8a6d1f"; g.font="bold 15px Arial";
      g.fillText(`📈 ${$("smaN").value} SMA`, MR-8, chY+24); g.textAlign="left"; }
    y=chY+chH+20;
    // per-chart lvlnote: each chart gets its own note under its slot
    g.font="13px Arial"; g.textAlign="left";
    CHARTS.forEach((c,i)=>{
      const x=ML+i*(slotW+gap);
      if(c && c._lvlNote && c._lvlNote.innerText.trim()){
        g.fillStyle="#3a4a68";
        const lines=wrapLines(g, c._lvlNote.innerText.replace(/\s+/g," ").trim(), slotW);
        lines.forEach((ln,k)=>{ g.fillText(ln, x, y+k*18); });
      }
    });
    y+=maxNoteLines*18+10;
  }
  y+=12;

  // --- Section 2: scenario table ---
  g.fillStyle="#3a4a68"; g.font="bold 19px Arial";
  g.fillText(LANG==="en"?"2 · Scenario Analysis":(LANG==="sc"?"2 · 情景分析":"2 · 情景分析"),ML,y); y+=8;
  const tbl=$("scnTable");
  const hdrCells=[...tbl.querySelectorAll("thead th")].map(th=>th.innerText.trim());
  const colX=[ML, ML+300, ML+440, ML+640, ML+940];   // 5 columns (W=1800)
  const colGap=12;
  g.font="bold 17px Arial"; g.fillStyle="#8a6d1f";
  hdrCells.forEach((c,ci)=>{ if(ci<colX.length) g.fillText(c,colX[ci],y+16); });
  y+=30;
  g.font="16px Arial";
  [...tbl.querySelectorAll("tbody tr")].forEach(r=>{
    const cells=[...r.querySelectorAll("td")];
    const linesPerCell=cells.map((cell,ci)=>{
      const w=(ci<colX.length-1?colX[ci+1]:MR)-colX[ci]-colGap;
      return wrapLines(g, cell.innerText.replace(/\s+/g," ").trim(), w);
    });
    const maxLines=Math.max(1,...linesPerCell.map(a=>a.length));
    const lh=24;
    cells.forEach((cell,ci)=>{
      if(ci>=colX.length)return;
      let color="#3a4a68";
      const sp=cell.querySelector("span");
      if(sp){ if(sp.classList.contains("good"))color="#099960"; else if(sp.classList.contains("bad"))color="#c41818"; }
      g.fillStyle=color;
      linesPerCell[ci].forEach((ln,k)=>g.fillText(ln,colX[ci],y+16+k*lh));
    });
    y+=maxLines*lh+10;
  });

  // --- Coupon & Observation Arrangement (mirrors on-screen scnDetail grid) ---
  y+=14;
  g.fillStyle="#8a6d1f"; g.font="bold 19px Arial";
  g.fillText(LANG==="en"?"Coupon & Observation Arrangement":(LANG==="sc"?"票息与收回安排":"票息與收回安排"),ML,y);
  y+=30;
  const KVW=210;                       // label column width
  const det=$("scnDetail");
  [...det.children].forEach(ch=>{
    const cls=(ch.className||"");
    if(cls.includes("scnhead2")){                 // section sub-header (到期未收回 / 打和價)
      y+=8; g.fillStyle="#8a6d1f"; g.font="bold 16px Arial";
      g.fillText(ch.innerText.trim(),ML,y); y+=26; return;
    }
    if(cls==="scnhead" || (cls.includes("scnhead") && !cls.includes("scnhead2"))) return; // main title, already drawn
    if(cls.includes("kv")){                        // key-value grid row(s)
      const kvs=[...ch.children];
      for(let i=0;i+1<kvs.length;i+=2){
        const k=kvs[i].innerText.trim(), v=kvs[i+1].innerText.replace(/\s+/g," ").trim();
        g.fillStyle="#5a6a85"; g.font="15px Arial"; g.textAlign="right";
        g.fillText(k, ML+KVW, y);
        g.textAlign="left"; g.font="bold 15px Arial";
        // value: if starts with a number/amount → highlight only that; otherwise whole value gold
        const numMatch = v.match(/^[US\$HK\$€]?\s*[\d,.]+[%]?/);
        if(numMatch){
          const numPart=numMatch[0];
          const restPart=v.slice(numPart.length);
          g.fillStyle="#8a6d1f"; g.fillText(numPart, ML+KVW+12, y);
          if(restPart){
            g.fillStyle="#5a6a85"; g.font="14px Arial";
            g.fillText(restPart, ML+KVW+12+g.measureText(numPart).width+6, y);
          }
        } else {
          g.fillStyle="#8a6d1f"; g.fillText(v, ML+KVW+12, y);
        }
        y+=26;
      }
      return;
    }
    if(cls.includes("warn")){                      // risk warning line
      g.fillStyle="#8a6d1f"; g.font="15px Arial";
      wrapLines(g,ch.innerText.trim(),MR-ML).forEach(ln=>{ g.fillText(ln,ML,y); y+=22; });
      y+=4; return;
    }
  });

  // --- footnote ---
  y+=14;
  g.fillStyle="#8a99b0"; g.font="13px Arial";
  g.fillText(`Generated ${new Date().toISOString().slice(0,10)} · ELN Pricer · Indicative only, not a guarantee of return.`,ML,y);

  // --- crop to used height + export ---
  const usedH=Math.min(tmp.height, y+24);
  const cv=document.createElement("canvas"); cv.width=W; cv.height=usedH;
  const ctx=cv.getContext("2d");
  ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality="high";
  ctx.drawImage(tmp,0,0,W,usedH,0,0,W,usedH);
  cv.toBlob(async blob=>{
    const fname=`ELN_${stk}_${new Date().toISOString().slice(0,10)}.jpg`;
    // Prefer Web Share API (mobile: saves to Photos / shares directly)
    if(navigator.canShare && navigator.canShare({files:[new File([blob],fname,{type:"image/jpeg"})]})){
      try{
        const file=new File([blob],fname,{type:"image/jpeg"});
        await navigator.share({files:[file],title:"ELN Pricer",text:fname});
        return;
      }catch(e){ /* user cancelled or share failed → fall through to download */ }
    }
    // Fallback: show full-resolution preview image (long-press to save on mobile)
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url; a.download=fname;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },"image/jpeg",0.95);
}
// CJK-aware word wrap: breaks per token (Chinese chars have no spaces -> per char),
// keeps latin words intact. Returns array of lines.
function wrapLines(ctx,text,maxW){
  if(!text)return [];
  const tokens=text.match(/\s+|\S/g)||[];
  const lines=[]; let line="";
  for(const tk of tokens){
    const test=line+tk;
    if(ctx.measureText(test).width>maxW && line!==""){ lines.push(line.trim()); line=(tk===" ")?"":tk; }
    else line=test;
  }
  if(line.trim()) lines.push(line.trim());
  return lines;
}
