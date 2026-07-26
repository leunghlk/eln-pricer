// ELN Pricer — app wiring
let LANG=localStorage.getItem("eln_lang")||"tc";
let CHART=null,SERIES=null,CALL_LINE=null,PUT_LINE=null;
let CUR={};              // current solved state for chart lines
let LAST_IV=null;        // last IV object (primary ticker)
let BASKET=[];           // selected tickers for basket
let BASKET_IV=[];        // [{sym, ivK, ivA}] fetched for basket members
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
  return {
    ticker:$("ticker").value, basket:$("basketOn").checked,
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
  $("tickerName").textContent="→ "+tickerName(p.ticker);
  await loadChart("6mo");
  await loadIV();
  recompute();
}

async function loadChart(range){
  $("chartErr").style.display="none";
  const p=readParams();
  const {data,source,provider}=await fetchCandles(p.ticker,range);
  CUR.spot=data.length?data[data.length-1].close:0;
  renderChart(data);
  if(source==="sample"){$("chartErr").style.display="block";
    $("chartErr").innerHTML='<span style="color:#ffb454">[SAMPLE 假數據 — 真實報價取不到，可能係 HK 股要 Twelve Data key，或 CORS 阻擋]</span>';}
  else{$("chartErr").style.display="block";
    $("chartErr").innerHTML=`<span style="color:#37d67a">● 真實數據：${provider}</span>`;}
}

function renderChart(data){
  if(!CHART){
    CHART=LightweightCharts.createChart($("chart"),{
      layout:{background:{color:"#0a1c38"},textColor:"#cfe0ff"},
      grid:{vertLines:{color:"#13294d"},horzLines:{color:"#13294d"}},
      rightPriceScale:{borderColor:"#1d3a66"},timeScale:{borderColor:"#1d3a66"},crosshair:{mode:1}});
    SERIES=CHART.addCandlestickSeries({upColor:"rgba(226,59,59,0)",downColor:"#1faa59",
      borderUpColor:"#e23b3b",borderDownColor:"#1faa59",wickUpColor:"#e23b3b",wickDownColor:"#1faa59",
      autoscaleInfoProvider:orig=>{
        const r=orig&&orig();
        if(!r||!CUR.spot)return r;
        const lvls=[];
        if(CUR.call)lvls.push(CUR.spot*CUR.call/100);
        if(CUR.put)lvls.push(CUR.spot*CUR.put/100);
        if(!lvls.length)return r;
        let lo=r.priceRange?r.priceRange.minValue:Math.min(...lvls);
        let hi=r.priceRange?r.priceRange.maxValue:Math.max(...lvls);
        lvls.forEach(v=>{lo=Math.min(lo,v);hi=Math.max(hi,v);});
        const pad=(hi-lo)*0.05||hi*0.05;
        return {priceRange:{minValue:lo-pad,maxValue:hi+pad}};
      }});
    // hollow bull = transparent body + red border; filled bear = green body
    CHART.subscribeCrosshairMove(onHover);
  }
  SERIES.setData(data);
  CHART.timeScale().fitContent();
  drawLevels();
}
function onHover(param){
  const tt=$("tooltip");
  if(!param.time||!param.point){tt.style.display="none";return;}
  const d=param.seriesData.get(SERIES);
  if(!d){tt.style.display="none";return;}
  const up=d.close>=d.open;
  tt.innerHTML=`<b>${param.time}</b><br>開 ${fmt(d.open)} · 高 ${fmt(d.high)}<br>低 ${fmt(d.low)} · 收 ${fmt(d.close)} `
    +`<span style="color:${up?'#e23b3b':'#1faa59'}">${up?'▲':'▼'}${fmt(d.close-d.open)}</span>`;
  tt.style.display="block";
  const wrap=$("chart").getBoundingClientRect();
  let x=param.point.x+16, y=param.point.y+12;
  if(x>wrap.width-170)x=param.point.x-170;
  tt.style.left=x+"px"; tt.style.top=y+"px";
}
function drawLevels(){
  if(!CHART)return;
  if(CALL_LINE)SERIES.removePriceLine(CALL_LINE);
  if(PUT_LINE)SERIES.removePriceLine(PUT_LINE);
  if(!CUR.spot||!CUR.call||!CUR.put)return;
  CALL_LINE=SERIES.createPriceLine({price:CUR.spot*CUR.call/100,color:"#37d67a",lineWidth:2,lineStyle:2,
    axisLabelVisible:true,title:`Call ${CUR.call}%`});
  PUT_LINE=SERIES.createPriceLine({price:CUR.spot*CUR.put/100,color:"#e23b3b",lineWidth:2,lineStyle:2,
    axisLabelVisible:true,title:`Put ${CUR.put}%`});
  // force y-axis to recompute so deep-OTM put line stays visible
  try{CHART.priceScale("right").applyOptions({autoScale:true});}catch(e){}
}

async function loadIV(){
  const p=readParams();
  const strikeGuess=p.put||45;
  const iv=await fetchIV(p.ticker,p.tenor,strikeGuess);
  LAST_IV=iv;
  if(iv.spot)CUR.spot=iv.spot;
  // basket: fetch IV for each selected member (parallel)
  BASKET_IV=[];
  if(p.basket && BASKET.length>=2){
    const results=await Promise.all(BASKET.map(s=>fetchIV(s,p.tenor,strikeGuess).catch(()=>null)));
    BASKET_IV=results.filter(Boolean).map((r,i)=>({sym:BASKET[i],ivK:r.atStrike,ivA:r.atm}));
  }
  renderBanks(iv);
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
      +`${iv.source==='live'?'live · '+ (iv.expiry||''):'sample (seeded)'}</div>`;
    box.appendChild(el);
  });
  $("ivNote").innerHTML = iv.source==="live"
    ? `✅ 真實 option IV（Yahoo，自動更新）· ATM ≈ <b>${pct(iv.atm*100,1)}</b> · strike(${pct((iv.strikeUsed&&CUR.spot)?iv.strikeUsed/CUR.spot*100:0,0)}) IV ≈ <b>${pct(iv.atStrike*100,1)}</b> · expiry ${iv.expiry}。5 行為按慣例 spread 調整之 indicative。`
    : `⚠ 真實 IV 暫取不到（HK 股或 rate-limit），顯示 <b>sample</b>。實盤以銀行 indicative 為準。`;
}

function recompute(){
  const p=readParams();
  if(p.basket && BASKET_IV.length>=2) p.basket=BASKET_IV;
  // ---- PREFER real FinIQ calibration table ----
  let calibHit=null;
  const hasCoupon=p.coupon!=null&&p.coupon!==""&&!isNaN(p.coupon);
  const hasPut=p.put!=null&&p.put!==""&&!isNaN(p.put);
  try{
    if(p.basket && BASKET.length>=2){
      // US basket? (has real quote table)
      const isUsBk = calibUsBasketPut(BASKET,p.coupon||18,p.mb,p.tenor,p.call)!=null;
      if(isUsBk){
        if(!hasPut && hasCoupon){const r=calibUsBasketPut(BASKET,p.coupon,p.mb,p.tenor,p.call); if(r)calibHit={put:r.put,coupon:p.coupon,src:`FinIQ US basket${r.bank?' ('+r.bank+')':''}`};}
        else if(!hasCoupon && hasPut){const r=calibUsBasketCoupon(BASKET,p.put,p.mb,p.tenor,p.call); if(r)calibHit={put:p.put,coupon:r.coupon,src:"FinIQ US basket"};}
        else if(!hasCoupon && !hasPut){const r=calibUsBasketPut(BASKET,18,p.mb,p.tenor,p.call); if(r)calibHit={put:r.put,coupon:r.quoteCoupon,src:"FinIQ US basket (預設)"};}
      } else {
        if(!hasPut && hasCoupon){const v=calibHkBasketPut(BASKET,p.coupon,p.mb); if(v!=null)calibHit={put:v,coupon:p.coupon,src:"FinIQ HK basket table"};}
        else if(!hasCoupon && hasPut){const v=calibHkBasketCoupon(BASKET,p.put,p.mb); if(v!=null)calibHit={put:p.put,coupon:v,src:"FinIQ HK basket table"};}
        else if(!hasCoupon && !hasPut){const v=calibHkBasketPut(BASKET,10,p.mb); if(v!=null)calibHit={put:v,coupon:10,src:"FinIQ HK basket table (預設10%)"};}
      }
    } else {
      if(!hasPut && hasCoupon){const v=calibUsPut(p.ticker,p.coupon,p.mb); if(v!=null)calibHit={put:v,coupon:p.coupon,src:"FinIQ single-stock table"};}
      else if(!hasCoupon && hasPut){const v=calibUsCoupon(p.ticker,p.put,p.mb); if(v!=null)calibHit={put:p.put,coupon:v,src:"FinIQ single-stock table"};}
      else if(!hasCoupon && !hasPut){const v=calibUsPut(p.ticker,8,p.mb); if(v!=null)calibHit={put:v,coupon:8,src:"FinIQ single-stock table (預設8%)"};}
    }
  }catch(e){}
  let out,solved;
  if(calibHit){
    out={...p,coupon:calibHit.coupon,put:calibHit.put,gross:+(calibHit.coupon+p.mb).toFixed(2),basketAdj:1};
    solved={which:(hasCoupon&&!hasPut)?"put":(hasPut&&!hasCoupon)?"coupon":"both",
      note:`${T("srcReal")} <b>${calibHit.src}</b> · ${T("cCoupon")} ${pct(calibHit.coupon)} · ${T("cPut")} ${pct(calibHit.put)}`};
  } else {
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
  drawLevels();
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
  // worst-of delivery details
  let worstName=p.ticker;
  if(p.basket && BASKET.length>=2) worstName=T("worstPerformer");
  // fee assumption 0.25% brokerage on delivery (typical)
  const feeRate=0.0025;
  const deliveryVal=shares*strikePx;
  const fee=deliveryVal*feeRate;
  const wholeShares=Math.floor(shares);
  const fracCash=(shares-wholeShares)*strikePx;
  const remainCash=fracCash - fee;   // odd-lot fractional returned as cash, less fee

  let html=`<div class="scnhead">${T("scnDetailTitle")}</div>`;
  html+=`<p>${T("perCpnLine")}：<b>${ccy}${fmt(S.perCpn,0)}</b>（${T("cCoupon")} ${pct(out.coupon)} p.a.）· ${T("maxTotalLine")}：<b>${ccy}${fmt(S.totalCpnIfHeld,0)}</b></p>`;
  html+=`<p>${T("obsLine")}：${p.callable==="daily"
      ? T("dailyObs").replace("{m}",S.firstObsMonths)
      : T("periodObs")}</p>`;
  html+=`<div class="scnhead2">${T("deliveryTitle")}</div>`;
  html+=`<p>${T("deliveryDesc")
      .replace("{worst}",`<b>${worstName}</b>`)
      .replace("{strikePct}",pct(out.put))
      .replace("{strikePx}",`${ccy}${fmt(strikePx,2)}`)
      .replace("{notional}",`${ccy}${fmt(notional,0)}`)
      .replace("{shares}",`<b>${fmt(wholeShares,0)}</b>`)}</p>`;
  html+=`<p>${T("deliveryCash")
      .replace("{fee}",`${ccy}${fmt(fee,2)}`)
      .replace("{cash}",`<b>${ccy}${fmt(Math.max(0,remainCash),2)}</b>`)}</p>`;
  html+=`<p class="warn">${T("deliveryRisk")}</p>`;
  $("scnDetail").innerHTML=html;
}

// ---- basket UI ----
function buildBasketChips(){
  const box=$("basketChips");box.innerHTML="";
  UNIVERSE.forEach(u=>{const c=document.createElement("span");c.className="chip";c.textContent=u[0];
    c.onclick=()=>{const i=BASKET.indexOf(u[0]);
      if(i>=0)BASKET.splice(i,1);else if(BASKET.length<4)BASKET.push(u[0]);
      c.classList.toggle("sel");};
    box.appendChild(c);});
}

// ---- init ----
function init(){
  const dl=$("tickers");UNIVERSE.forEach(u=>{const o=document.createElement("option");o.value=u[0];o.label=u[2];dl.appendChild(o);});
  buildBasketChips();
  applyLang();
  document.querySelectorAll(".langsw button").forEach(b=>b.onclick=()=>{LANG=b.dataset.l;localStorage.setItem("eln_lang",LANG);applyLang();});
  $("run").onclick=runAll;
  $("reset").onclick=()=>location.reload();
  $("basketOn").onchange=e=>$("basketBox").classList.toggle("on",e.target.checked);
  document.querySelectorAll(".toolbar [data-r]").forEach(b=>b.onclick=()=>loadChart(b.dataset.r).then(recompute));
  $("refresh").onclick=()=>runAll();
  ["call","mb","coupon","put","cfreq","callable","tenor","notional","lockout","issue"].forEach(id=>
    $(id).addEventListener("input",()=>{if(CUR.spot)recompute();}));
  // default issue = today
  $("issue").value=new Date().toISOString().slice(0,10);
  setTimeout(runAll,300);
}
window.addEventListener("load",init);
