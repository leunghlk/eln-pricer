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
    const m={tc:"Coupon 同 Put/Strike 只可填一項，另一項留空由系統求解。請清走其中一個。",
             sc:"Coupon 与 Put/Strike 只可填一项，另一项留空由系统求解。请清除其中一个。",
             en:"Fill in ONLY ONE of Coupon / Put-Strike — the other must stay blank for the solver. Please clear one."};
    $("err").style.display="block";$("err").textContent=(m[LANG]||m.tc);
    return;
  }
  $("tickerName").textContent="→ "+tickerName(p.ticker);
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
    layout:{background:{color:"#0a1c38"},textColor:"#cfe0ff"},
    grid:{vertLines:{color:"#13294d"},horzLines:{color:"#13294d"}},
    rightPriceScale:{borderColor:"#1d3a66"},timeScale:{borderColor:"#1d3a66"},crosshair:{mode:1}});
  const series=chart.addCandlestickSeries({upColor:"rgba(226,59,59,0)",downColor:"#1faa59",
    borderUpColor:"#e23b3b",borderDownColor:"#1faa59",wickUpColor:"#e23b3b",wickDownColor:"#1faa59"});
  const maSeries=chart.addLineSeries({color:"#f5c542",lineWidth:2,priceLineVisible:false,lastValueVisible:true,
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
      ? '<span style="color:#ffb454">[SAMPLE 假數據]</span>'
      : '<span style="color:#37d67a">● 真實數據：'+all[i].provider+'</span>';
    cap.innerHTML=`<b>${t}</b> · ${tickerName(t)} <span style="font-size:11px">${src}</span>`;
    const el=document.createElement("div");el.className="subel";el.style.height="300px";el.style.position="relative";
    const tt=document.createElement("div");tt.className="cht-tt";tt.style.display="none";
    const lvlNote=document.createElement("div");lvlNote.className="lvlnote";
    box.appendChild(cap);box.appendChild(el);el.appendChild(tt);box.appendChild(lvlNote);wrap.appendChild(box);
    const c=newChart(el);
    c._spot = all[i].data.length ? all[i].data[all[i].data.length-1].close : 0;
    c._tt = tt; c._lvlNote = lvlNote; c._data = all[i].data;
    c.series.setData(all[i].data);
    c.chart.timeScale().fitContent();
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
    `<span style="color:${up?'#e23b3b':'#1faa59'}">${up?'▲':'▼'}${fmt(d.close-d.open)}</span>`;
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
  if(!c._spot||!CUR.call||!CUR.put)return;
  const putPx=c._spot*CUR.put/100;
  c._call=c.series.createPriceLine({price:c._spot*CUR.call/100,color:"#37d67a",lineWidth:2,lineStyle:2,axisLabelVisible:true,title:`Call ${CUR.call}%`});
  c._put =c.series.createPriceLine({price:putPx,color:"#e23b3b",lineWidth:2,lineStyle:2,axisLabelVisible:true,title:`Put ${CUR.put}%`});
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
    // pricing driver = highest-vol component (worst-of)
    const live=BASKET_IV.filter(x=>x.src==="live");
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
    el.innerHTML=`<div class="n">${x.sym}${isDrv?" ★":""}</div><div class="iv">${pct(x.ivA*100,1)}</div>`
      +`<div class="m">ATM IV · strike IV ${pct(x.ivK*100,1)}</div>`
      +`<div class="st ${x.src==='live'?'live':'samp'}">${x.src==='live'?('live · '+(x.expiry||'')):'sample'}</div>`;
    box.appendChild(el);
  });
  if(!list.length){
    box.innerHTML='<div class="bank samp">—</div>';
  }
  const names=list.map(x=>`${x.sym} ${pct(x.ivA*100,1)}`).join(" · ");
  let note;
  if(LANG==="en"){
    note=`✅ Real per-stock Option IV (auto-updated): ${names}. Worst-of pricing is driven by <b>${drv?drv.sym:"—"}</b> (highest IV).`;
  }else if(LANG==="sc"){
    note=`✅ 篮子内各股真实 Option IV（自动更新）：${names}。Worst-of 定价由 <b>${drv?drv.sym:"—"}</b>（最高 IV）主导。`;
  }else{
    note=`✅ 籃子內各股真實 Option IV（自動更新）：${names}。Worst-of 定價由 <b>${drv?drv.sym:"—"}</b>（最高 IV）主導。`;
  }
  const anySample=list.some(x=>x.src!=="live");
  if(anySample||!list.length){
    note += LANG==="en" ? " ⚠ Components without live IV (e.g. HK stocks) use calibrated table pricing."
         : LANG==="sc" ? " ⚠ 无 live IV 之成分股（如港股）以校准表定价。"
         : " ⚠ 無 live IV 之成分股（如港股）以校準表定價。";
  }
  $("ivNote").innerHTML=note;
}

function renderBanks(iv){
  const box=$("banks");box.innerHTML="";
  const banks=["HSBC","JPM","BNP","UBS","SG","Barclays"];
  const seeds={HSBC:1.0,JPM:0.98,BNP:1.05,UBS:1.02,SG:1.08,Barclays:1.03};
  const base=iv.atm||0.5;
  banks.forEach(b=>{
    const v=base*seeds[b]*(0.98+Math.random()*0.04);
    const el=document.createElement("div");el.className="bank";
    el.innerHTML=`<div class="n">${b}</div><div class="iv">${pct(v*100,1)}</div>`
      +`<div class="m">ATM IV</div><div class="st ${iv.source==='live'?'live':'samp'}">`
      +`${iv.source==='live'?('live · '+ (iv.expiry||'')):'sample (seeded)'}</div>`;
    box.appendChild(el);
  });
  const atm=pct(iv.atm*100,1), stk=pct((iv.strikeUsed&&CUR.spot)?iv.strikeUsed/CUR.spot*100:0,0), stkiv=pct(iv.atStrike*100,1), exp=iv.expiry||"";
  let note;
  if(iv.source==="live"){
    note = (LANG==="en")
      ? `✅ Real Option IV (auto-updated via Yahoo) · ATM ≈ <b>${atm}</b> · strike(${stk}) IV ≈ <b>${stkiv}</b> · expiry ${exp}. Bank rows are indicative (spread-adjusted).`
      : (LANG==="sc")
      ? `✅ 真实 Option IV（自动更新）· ATM ≈ <b>${atm}</b> · strike(${stk}) IV ≈ <b>${stkiv}</b> · 到期 ${exp}。各行均为按惯例 spread 调整的 indicative。`
      : `✅ 真實 Option IV（自動更新）· ATM ≈ <b>${atm}</b> · strike(${stk}) IV ≈ <b>${stkiv}</b> · 到期 ${exp}。各行均為按慣例 spread 調整之 indicative。`;
  } else {
    note = (LANG==="en")
      ? `⚠ Live IV unavailable (HK stock or rate-limit); showing <b>sample</b>. Refer to bank indicative for actual terms.`
      : (LANG==="sc")
      ? `⚠ 真实 IV 暂取不到（港股或 rate-limit），显示 <b>sample</b>。实际以银行 indicative 为准。`
      : `⚠ 真實 IV 暫取不到（港股或 rate-limit），顯示 <b>sample</b>。實盤以銀行 indicative 為準。`;
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
      }
    } else if(isHK(usSym(p.ticker))) {
      // HK single — calibration table only
      if(!hasPut && hasCoupon){const v=calibHkSinglePut(p.ticker,p.coupon,p.mb); if(v!=null)calibHit={put:v,coupon:p.coupon,src:"FinIQ HK single table"};}
      else if(!hasCoupon && hasPut){const v=calibHkSingleCoupon(p.ticker,p.put); if(v!=null)calibHit={put:p.put,coupon:v,src:"FinIQ HK single table"};}
      else if(!hasCoupon && !hasPut){const v=calibHkSinglePut(p.ticker,10,p.mb); if(v!=null)calibHit={put:v,coupon:10,src:"FinIQ HK single (預設10%)"};}
    }
    // US single: NOT using static table (IV volatile) → fall through to live IV model
  }catch(e){}

  let out,solved;
  if(calibHit){
    out={...p,coupon:calibHit.coupon,put:calibHit.put,gross:+(calibHit.coupon+p.mb).toFixed(2),basketAdj:1};
    solved={which:(hasCoupon&&!hasPut)?"put":(hasPut&&!hasCoupon)?"coupon":"both",
      note:`${T("cCoupon")} ${pct(calibHit.coupon)} · ${T("cPut")} ${pct(calibHit.put)}`};
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
  renderScenarios(S,p,out);
}

function renderScenarios(S,p,out){
  const tb=$("scnBody");tb.innerHTML="";
  const cpA=out.coupon/100;
  const rows=[
    {t:T("sc1"),called:T("yes"),cpn:sym(p.ccy)+fmt(S.cpnByFirstObs,0),
     prin:T("prinBack"),ret:"+"+pct(cpA*(S.firstObsMonths/12)*100),cls:"good"},
    {t:T("sc2"),called:T("yes"),cpn:T("cpnAccrued"),
     prin:T("prinBack"),ret:"+"+T("cpnAccrued"),cls:"good"},
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
  let html=`<div class="scnhead">${T("scnDetailTitle")}</div>`;
  html+=`<p>${T("perCpnLine")}：${hl(ccy+fmt(S.perCpn,0))}（${T("cCoupon")} ${pct(out.coupon)} p.a.）· ${T("maxTotalLine")}：${hl(ccy+fmt(S.totalCpnIfHeld,0))}</p>`;
  html+=`<p>${T("obsLine")}：${p.callable==="daily"
      ? T("dailyObs").replace("{m}",S.firstObsMonths)
      : T("periodObs")}</p>`;
  html+=`<div class="scnhead2">${T("deliveryTitle")}</div>`;
  html+=`<p>${T("deliveryDesc")
      .replace("{worst}",hl(worstName))
      .replace("{strikePct}",hl(pct(out.put)))
      .replace("{strikePx}",hl(ccy+fmt(strikePx,2)))
      .replace("{notional}",hl(ccy+fmt(notional,0)))
      .replace("{shares}",hl(fmt(wholeShares,0)))}</p>`;
  html+=`<p>${T("deliveryCash")
      .replace("{fee}",hl(ccy+fmt(fee,2)))
      .replace("{cash}",hl(ccy+fmt(Math.max(0,remainCash),2)))}</p>`;
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
  ["call","mb","coupon","put","cfreq","callable","tenor","notional","lockout","issue","bk1","bk2","bk3"].forEach(id=>
    $(id).addEventListener("input",()=>{if(CUR.spot)recompute();}));
  $("issue").value=new Date().toISOString().slice(0,10);
  // default demo state: put=45 filled so initial auto-run passes validation
  if($("coupon").value===""&&$("put").value==="")$("put").value=45;
  setTimeout(runAll,300);
}
window.addEventListener("load",init);
