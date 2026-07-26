// ELN Pricer — solver + scenario engine
// CALIBRATION ANCHOR (your quote): SNDK 3M, MB 1%, Call 90%, Put ~45% -> Client Coupon ~20% p.a.
// MB = Monetary Benefits = RM commission ("食幾多"). Client coupon = gross - MB.
// Model (calibrated heuristic, NOT a bank Monte-Carlo pricer):
//   client_coupon_pa = (put%/100) * IV_atStrike * KCAL * tenorAdj * freqAdj
//   Higher put strike -> client takes more downside risk -> higher coupon.
//   Uses REAL option IV at the strike as the market input.
// KCAL derived from anchor: 0.20 = 0.45 * IV_REF * KCAL, with IV_REF (deep-put skew) = 0.90
const IV_REF = 0.90;
const KCAL = 0.20 / (0.45 * IV_REF); // ~0.4938

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
    // dispersion premium: more names & wider vol spread => higher coupon
    const dispersion = (maxK-avgK)/Math.max(avgK,0.01);   // 0..~0.5
    basketAdj = 1 + 0.14*(n-1) + 0.6*dispersion;          // e.g. 3 names => ~1.28+
    basketNote = ` · basket worst-of ×${basketAdj.toFixed(2)}（${n}隻，用最高 IV ${(maxK*100).toFixed(0)}%＋dispersion）`;
  }
  const tenorAdj = 1;
  const freqAdj  = p.callable==="daily" ? 1.0 : 1.03;

  if(!hasPut && !hasCoupon){
    out.put = 45;
    out.coupon = +(( (out.put/100) * ivK * KCAL * tenorAdj * freqAdj * basketAdj )*100).toFixed(2);
    out.gross = +(out.coupon + p.mb).toFixed(2);
    solved={which:"both", note:`預設 put=45%（deep-OTM）→ 用 strike IV ${(ivK*100).toFixed(1)}% 解 client coupon`+basketNote};
  } else if(!hasCoupon){
    out.coupon = +(( (p.put/100) * ivK * KCAL * tenorAdj * freqAdj * basketAdj )*100).toFixed(2);
    out.gross = +(out.coupon + p.mb).toFixed(2);
    solved={which:"coupon", note:`put ${p.put}% × strike IV ${(ivK*100).toFixed(1)}% × K ${KCAL.toFixed(3)} × freqAdj ${freqAdj} → client coupon（gross ${out.gross}% − MB ${p.mb}%）`+basketNote};
  } else if(!hasPut){
    const cp = p.coupon/100;
    out.put = +(( cp / (ivK * KCAL * tenorAdj * freqAdj * basketAdj) )*100).toFixed(2);
    out.coupon = p.coupon; out.gross=+(p.coupon+p.mb).toFixed(2);
    solved={which:"put", note:`client coupon ${p.coupon}% ÷ (strike IV ${(ivK*100).toFixed(1)}% × K ${KCAL.toFixed(3)} × freqAdj ${freqAdj}${basketAdj!==1?` × basket ${basketAdj.toFixed(2)}`:""}) → put/strike`+basketNote};
  } else {
    out.gross=+(p.coupon+p.mb).toFixed(2);
    solved={which:"none", note:`已全部輸入。gross ${out.gross}% = client ${p.coupon}% + MB ${p.mb}%。Call ${p.call}% / Put ${p.put}%`+basketNote};
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
