// ELN Pricer — solver + scenario engine
// CALIBRATION (two real anchors, reconciled by a sqrt-IV model):
//   A1 (historical FinIQ): SNDK 45% put @ strike-IV 90%  -> 20% CLIENT coupon @ MB1 (gross 21)
//   A2 (current market):   SNDK 40% put @ strike-IV 230% -> ~30% client coupon
// MB = Monetary Benefits = RM commission.
// GROSS-BASED MODEL (MB feeds through):
//   gross_pa = (put%/100) * sqrt(IV_atStrike) * KCAL_G * freqAdj * basketAdj
//   client   = gross - MB          (MB up => client coupon down)
//   reverse: put% = (client+MB) / (sqrt(IV)*KCAL_G*freq*basket*callAdj)   (MB up => strike up)
// KCAL_G from A1: gross 21 = 45 * sqrt(0.90) * K  ->  K = 0.4917
const IV_REF = 0.90;
const KCAL = 0.21 / (0.45 * Math.sqrt(IV_REF)); // gross-based ~0.4917
const ivPow = iv => Math.sqrt(Math.max(iv,0.01));

// Call-level adjustment: lower call level -> easier autocall -> issuer takes LESS downside
// -> issuer demands HIGHER strike (so put% HIGHER, coupon LOWER). Calibrated to real FinIQ:
//   DELL single: 100c=90c=49p (user-confirmed, flat above 90c). Below 80c strike rises.
//   70c should be HIGHER strike than 90c => callAdj(70c) > 1.0 (multiply into put% UP).
//   Use 70c ≈ 1.08 (strike ~8% higher vs 90c), 80c ≈ 1.03.
const CALL_ADJ = {100:1.0, 90:1.0, 80:1.03, 70:1.08};
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
    out.put = +(45 * cAdj).toFixed(2);
    const gross = (out.put/100) * ivPow(ivK) * KCAL * freqAdj * basketAdj * 100;
    out.gross = +gross.toFixed(2);
    out.coupon = +(gross - p.mb).toFixed(2);          // MB ↑ → client coupon ↓
    solved={which:"both", note:`預設 put=45% → 用 strike IV ${(ivK*100).toFixed(0)}% 解 client coupon（gross ${out.gross}% − MB ${p.mb}%）`+basketNote};
  } else if(!hasCoupon){
    out.put = +(p.put * cAdj).toFixed(2);
    const gross = (out.put/100) * ivPow(ivK) * KCAL * freqAdj * basketAdj * 100;
    out.gross = +gross.toFixed(2);
    out.coupon = +(gross - p.mb).toFixed(2);          // MB ↑ → client coupon ↓
    solved={which:"coupon", note:`put ${out.put}% (call ${p.call}%) × √(strike IV ${(ivK*100).toFixed(0)}%) → gross ${out.gross}% − MB ${p.mb}% → client coupon`+basketNote};
  } else if(!hasPut){
    const grossTarget = (p.coupon + p.mb)/100;        // MB ↑ → 需要更高 gross → strike ↑
    out.put = +(( grossTarget / (ivPow(ivK) * KCAL * freqAdj * basketAdj * cAdj) )*100).toFixed(2);
    out.coupon = p.coupon; out.gross=+(p.coupon+p.mb).toFixed(2);
    solved={which:"put", note:`(client ${p.coupon}% + MB ${p.mb}%) ÷ (√(strike IV ${(ivK*100).toFixed(0)}%) × call ${p.call}% adj) → put/strike`+basketNote};
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

// Risk-free carry rate per currency (for breakeven-with-interest)
const RF_RATE = { USD:0.043, HKD:0.048, EUR:0.035 };
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
  // ---- Breakeven spot assuming DELIVERY at maturity, INCLUDING interest earned ----
  // Client invests `notional`; over tenor T earns coupons (totalCpnIfHeld) AND forwent
  // risk-free interest = notional * r * T. Effective cost basis of delivered shares =
  // notional - coupons - interest. Breakeven spot = effective cost / shares.
  const r = RF_RATE[o.ccy]!=null ? RF_RATE[o.ccy] : 0.04;
  const interestEarned = notional * r * (o.tenor/12);
  const beSpot = strikePx>0 ? strikePx - (totalCpnIfHeld + interestEarned)/shares : 0;
  // bePct as % of spot: beSpot/spot*100 = put * (1 - (coupons+interest)/notional). (put already in %)
  const bePct = put>0 ? put * (1 - (totalCpnIfHeld + interestEarned)/notional) : 0;
  return {perCpn,totalCpnIfHeld,shares,strikePx,put,spot,cdates:cdates.length,cpnByFirstObs,firstObsMonths,notional,ccy:o.ccy,
    beSpot,bePct,rfRate:r,interestEarned};
}
