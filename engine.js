// ELN Pricer — solver + scenario engine
// CALIBRATION (two real anchors, reconciled by a sqrt-IV model):
//   A1 (historical FinIQ): SNDK 45% put @ strike-IV 90%  -> 20% client coupon
//   A2 (current market):   SNDK 40% put @ strike-IV 230% -> ~30% client coupon
// MB = Monetary Benefits = RM commission. Client coupon = gross - MB.
// Model:  client_coupon_pa = (put%/100) * sqrt(IV_atStrike) * KCAL * freqAdj * basketAdj
//   sqrt(IV) captures option value scaling with vol without over-shooting at extreme IV.
const IV_REF = 0.90;
const KCAL = 0.20 / (0.45 * Math.sqrt(IV_REF)); // ~0.4683
const ivPow = iv => Math.sqrt(Math.max(iv,0.01));

// Call-level adjustment: lower call level -> easier autocall -> issuer takes LESS downside
// -> HIGHER strike (lower coupon). Calibrated to real FinIQ basket table
// (SNDK+INTC: 90c=54, 80c=55, 70c=58; 100c slightly lower).
// 90c is the base (=1.0).
const CALL_ADJ = {100:0.98, 90:1.0, 80:1.018, 70:1.074};
function callAdj(call){
  const cs=Object.keys(CALL_ADJ).map(Number).sort((a,b)=>a-b);
  if(call>=cs[cs.length-1]) return CALL_ADJ[cs[cs.length-1]];
  if(call<=cs[0]) return CALL_ADJ[cs[0]];
  for(let i=0;i<cs.length-1;i++){
    const a=cs[i],b=cs[i+1];
    if(call>=a && call<=b){
      const f=(call-a)/(b-a);
      return +(CALL_ADJ[a]+(CALL_ADJ[b]-CALL_ADJ[a])*f).toFixed(4);
    }
  }
  return 1.0;
}

function solveParams(p, iv){
  const out={...p}; let solved=null;
  const hasCoupon = p.coupon!=null && p.coupon!=="" && !isNaN(p.coupon);
  const hasPut    = p.put!=null && p.put!=="" && !isNaN(p.put);
  let ivK = (iv && iv.atStrike) ? iv.atStrike : IV_REF;
  let ivA = (iv && iv.atm) ? iv.atm : 0.5;
  // ---- BASKET worst-of adjustment ----
  let basketAdj = 1, basketNote = "";
  if(p.basket && p.basket.length>=2){
    const n=p.basket.length;
    const ksAll = p.basket.map(b=>b.ivK||ivK);
    const maxK = Math.max(...ksAll);
    const avgK = ksAll.reduce((a,b)=>a+b,0)/n;
    ivK = maxK;
    ivA = Math.max(...p.basket.map(b=>b.ivA||ivA));
    const dispersion = (maxK-avgK)/Math.max(avgK,0.01);
    basketAdj = 1 + 0.14*(n-1) + 0.6*dispersion;
    basketNote = ` · basket worst-of ×${basketAdj.toFixed(2)}（${n}隻，用最高 IV ${(maxK*100).toFixed(0)}%＋dispersion）`;
  }
  const freqAdj  = p.callable==="daily" ? 1.0 : 1.03;
  const cAdj = callAdj(p.call);   // lower call -> higher strike

  if(!hasPut && !hasCoupon){
    out.put = 45 * cAdj;
    out.coupon = +(( (out.put/100) * ivPow(ivK) * KCAL * freqAdj * basketAdj )*100).toFixed(2);
    out.gross = +(out.coupon + p.mb).toFixed(2);
    solved={which:"both", note:`預設 put=45% → 用 strike IV ${(ivK*100).toFixed(0)}% 解 client coupon`+basketNote};
  } else if(!hasCoupon){
    out.put = p.put * cAdj;
    out.coupon = +(( (out.put/100) * ivPow(ivK) * KCAL * freqAdj * basketAdj )*100).toFixed(2);
    out.gross = +(out.coupon + p.mb).toFixed(2);
    solved={which:"coupon", note:`put ${out.put}% (call ${p.call}%) × √(strike IV ${(ivK*100).toFixed(0)}%) → client coupon`+basketNote};
  } else if(!hasPut){
    const cp = p.coupon/100;
    out.put = +(( cp / (ivPow(ivK) * KCAL * freqAdj * basketAdj * cAdj) )*100).toFixed(2);
    out.coupon = p.coupon; out.gross=+(p.coupon+p.mb).toFixed(2);
    solved={which:"put", note:`client coupon ${p.coupon}% ÷ (√(strike IV ${(ivK*100).toFixed(0)}%) × call ${p.call}% adj) → put/strike`+basketNote};
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
