// ELN Pricer — solver + scenario engine
// CALIBRATION (two real anchors, reconciled by a sqrt-IV model):
//   A1 (historical FinIQ): SNDK 45% put @ strike-IV 90%  -> 20% client coupon
//   A2 (current market):   SNDK 40% put @ strike-IV 230% -> ~30% client coupon
// MB = Monetary Benefits = RM commission. Client coupon = gross - MB.
// Model:  client_coupon_pa = (put%/100) * sqrt(IV_atStrike) * KCAL * freqAdj * basketAdj
//   sqrt(IV) captures option value scaling with vol without over-shooting at extreme IV.
// KCAL from A1: 0.20 = 0.45 * sqrt(0.90) * KCAL  ->  KCAL = 0.4683
const IV_REF = 0.90;
const KCAL = 0.20 / (0.45 * Math.sqrt(IV_REF)); // ~0.4683
const ivPow = iv => Math.sqrt(Math.max(iv,0.01));

function solveParams(p, iv){
  // p: {call, mb, tenor, callable, cfreq, coupon(null|num), put(null|num), basket:[{sym,ivK,ivA}]?}
  // iv: {atm, atStrike, spot, source}
  const out={...p}; let solved=null;
  const hasCoupon = p.coupon!=null && p.coupon!=="" && !isNaN(p.coupon);
  const hasPut    = p.put!=null && p.put!=="" && !isNaN(p.put);
  let ivK = (iv && iv.atStrike) ? iv.atStrike : IV_REF;
  let ivA = (iv && iv.atm) ? iv.atm : 0.5;
  // ---- BASKET worst-of adjustment ----
  // Worst-of pays MORE coupon: driven by the HIGHEST vol name + dispersion premium.
  let basketAdj = 1, basketNote = "";
  if(p.basket && p.basket.length>=2){
    const n=p.basket.length;
    const ksAll = p.basket.map(b=>b.ivK||ivK);
    const maxK = Math.max(...ksAll);
    const avgK = ksAll.reduce((a,b)=>a+b,0)/n;
    ivK = maxK;                 // worst performer ≈ highest-vol name drives the put
    ivA = Math.max(...p.basket.map(b=>b.ivA||ivA));
    const dispersion = (maxK-avgK)/Math.max(avgK,0.01);   // 0..~0.5
    basketAdj = 1 + 0.14*(n-1) + 0.6*dispersion;
    basketNote = ` · basket worst-of ×${basketAdj.toFixed(2)}（${n}隻，用最高 IV ${(maxK*100).toFixed(0)}%＋dispersion）`;
  }
  const freqAdj  = p.callable==="daily" ? 1.0 : 1.03;

  if(!hasPut && !hasCoupon){
    out.put = 45;
    out.coupon = +(( (out.put/100) * ivPow(ivK) * KCAL * freqAdj * basketAdj )*100).toFixed(2);
    out.gross = +(out.coupon + p.mb).toFixed(2);
    solved={which:"both", note:`預設 put=45% → 用 strike IV ${(ivK*100).toFixed(0)}% 解 client coupon`+basketNote};
  } else if(!hasCoupon){
    out.coupon = +(( (p.put/100) * ivPow(ivK) * KCAL * freqAdj * basketAdj )*100).toFixed(2);
    out.gross = +(out.coupon + p.mb).toFixed(2);
    solved={which:"coupon", note:`put ${p.put}% × √(strike IV ${(ivK*100).toFixed(0)}%) → client coupon`+basketNote};
  } else if(!hasPut){
    const cp = p.coupon/100;
    out.put = +(( cp / (ivPow(ivK) * KCAL * freqAdj * basketAdj) )*100).toFixed(2);
    out.coupon = p.coupon; out.gross=+(p.coupon+p.mb).toFixed(2);
    solved={which:"put", note:`client coupon ${p.coupon}% ÷ √(strike IV ${(ivK*100).toFixed(0)}%) → put/strike`+basketNote};
  } else {
    out.gross=+(p.coupon+p.mb).toFixed(2);
    solved={which:"none", note:`已全部輸入。Call ${p.call}% / Put ${p.put}%`+basketNote};
  }
  out.basketAdj=basketAdj;
  return {out, solved};
}

function couponsPerYear(freq){return {monthly:12,quarterly:4,semi:2,annual:1}[freq]||12;}
function couponDates(issue,tenorM,freq){
  const step={monthly:1,quarterly:3,semi:6,annual:12}[freq];
  const n=Math.ceil(tenorM/step); const dts=[];
  for(let i=1;i<=n;i++){const d=new Date(issue);d.setMonth(d.getMonth()+i*step);dts.push(d);}
  return dts;
}

function buildScenarios(o){
  // o: solved params incl coupon(client %), put, tenor, cfreq, notional, ccy, spot, lockout
  const notional=o.notional, cpA=o.coupon/100;
  const m=couponsPerYear(o.cfreq);
  const perCpn=notional*cpA/m;
  const issue=o.issue?new Date(o.issue):new Date();
  const cdates=couponDates(issue,o.tenor,o.cfreq);
  const totalCpnIfHeld=perCpn*cdates.length;
  const put=o.put, spot=o.spot||0;
  const strikePx = spot*(put/100);
  const shares = strikePx>0 ? notional/strikePx : 0;
  // lockout: earliest call = lockout months
  const firstObsMonths=o.lockout||1;
  const cpnByFirstObs = perCpn*Math.max(1, Math.round(firstObsMonths/(12/m)));
  return {perCpn,totalCpnIfHeld,shares,strikePx,put,spot,cdates:cdates.length,cpnByFirstObs,firstObsMonths,notional,ccy:o.ccy};
}
