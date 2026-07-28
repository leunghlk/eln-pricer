// ELN Pricer — BS-based calibration (Bloomberg 3M 100%-moneyness IV)
// Uses bs_calib_data.js globals: BLOOMBERG_IV, CALIB_ANCHOR, CALIB_DEFAULT_ANCHOR,
//   RICH_BS, BS_R. Requires live spot CUR.spot (set by app.js after candle load).
// Model: coupon = beta*BS_mid(S,strike,T,r,iv) + cb*(call-100)/10 - mbAdj(mb)
//   beta for RICH4 absorbs Bloomberg IV (recomputed). Anchor stocks: beta=8/BS_mid(anchor).
//   tenor T = tenorMonths/12 (NOT hardcoded). cfreq shifts strike. mbAdj convex (not linear).
// Validated: RICH4 MB1 anchors exact; all anchors exact 8.00 @ anchor strike.
// NOTE: cfreq coefficient is PROVISIONAL (user to confirm exact monthly-vs-annual spread).

function bsNormCdf(x){ return 0.5*(1+Math.sign(x)*Math.sqrt(1-Math.exp(-2*x*x/Math.PI))); }
function bsPut(S,K,Tt,r,sig,q){
  q=q||0;
  if(Tt<=0||sig<=0) return Math.max(K-S,0);
  const d1=(Math.log(S/K)+(r-q+0.5*sig*sig)*Tt)/(sig*Math.sqrt(Tt));
  const d2=d1-sig*Math.sqrt(Tt);
  return K*Math.exp(-r*Tt)*bsNormCdf(-d2)-S*Math.exp(-q*Tt)*bsNormCdf(-d1);
}
// Black-Scholes put premium as TOTAL % of spot (NOT annualized).
// Rationale: ELN coupon is p.a. but tenor is fixed; shorter tenor -> less total premium paid ->
// issuer can offer HIGHER strike (less protection). Total premium (not /Tt) gives correct tenor sign.
function bsMid(S,strikePct,Tt,r,sig){
  const K=S*strikePct;
  return (bsPut(S,K,Tt,r,sig)/S)*100;
}

// ---- tenor-aware T ----
// NOTE: BS_T/BS_R still exported for fallback; live uses tenorMonths/12
function bsTenorT(tenorMonths){ return Math.max(tenorMonths,0.5)/12; }

// ---- coupon frequency strike shift (PROVISIONAL) ----
// User confirmed: same coupon, annual strike < monthly strike (issuer carry lower).
// factor multiplies solved strike% (lower factor = lower strike). To be fit when user supplies A data.
const BS_FREQ_FACTOR = { monthly:1.00, quarterly:0.985, semi:0.970, annual:0.950 };

// ---- MB unit normalizer: dashboard passes MB as PERCENT integer (1,2,3);
//      decimal form is <=0.03 (3%). Threshold 0.1 cleanly separates the two. ----
function bsMbNorm(mb){ return mb>0.1 ? mb/100 : mb; }

// ---- convex MB adjustment (replaces linear -ms*(mb-1)) ----
// Zero at MB1 (baseline). Each +1% MB above MB1 adds ~3pt (diminishing).
function bsMbAdj(mb){
  const m=bsMbNorm(mb);
  const d = m*100 - 1;            // increment above MB1 (0 at MB1)
  if(d<=0) return 0;
  const k1=3.0, k2=0.5;
  return k1*d - k2*Math.max(d-1,0);
}

// ---- min coupon (RM cannot eat more than client) ----
// minCoupon% = (12 / tenorMonths) * mb%   [user rule: 3M MB2%=8, 2M MB2%=12]
function bsMinCoupon(tenorMonths, mb){
  const m=bsMbNorm(mb);
  return (12 / Math.max(tenorMonths,0.5)) * (m*100);
}

// ---- beta lookup for a given (ticker, strikePct) ----
function bsBeta(tk, strikePct, iv){
  if(RICH_BS[tk]){
    const betas=RICH_BS[tk].beta, cbs=RICH_BS[tk].cb;
    const keys=Object.keys(betas).map(parseFloat).sort((a,b)=>a-b);
    let beta,cb;
    if(strikePct<=keys[0]){ beta=betas[keys[0].toString()]; cb=cbs[keys[0].toString()]; }
    else if(strikePct>=keys[keys.length-1]){ const k=keys[keys.length-1].toString(); beta=betas[k]; cb=cbs[k]; }
    else {
      for(let i=0;i<keys.length-1;i++){
        const a=keys[i], b=keys[i+1];
        if(strikePct>=a && strikePct<=b){
          const f=(strikePct-a)/(b-a);
          const ka=a.toString(), kb=b.toString();
          beta = betas[ka]+(betas[kb]-betas[ka])*f;
          cb   = cbs[ka]+(cbs[kb]-cbs[ka])*f; break;
        }
      }
    }
    return {beta, cb};
  }
  // anchor or default-anchor: beta pinned so anchor strike -> 8.00 (independent of S)
  const anc = (CALIB_ANCHOR[tk]!=null?CALIB_ANCHOR[tk]:CALIB_DEFAULT_ANCHOR[tk])/100;
  const beta = 8.0 / bsMid(CUR.spot, anc, bsTenorT(CUR._tenor||3), BS_R, iv);
  return {beta, cb:0};
}

// ---- availability check ----
function bsCalibAvailable(ticker){
  const tk=normSym(ticker);
  return !!(BLOOMBERG_IV[tk] && CUR.spot && CUR.spot>0);
}

// ---- solve put from coupon (single stock) ----
function calibBsSinglePut(ticker, coupon, mb, call, tenor, cfreq){
  const tk=normSym(ticker); const iv=BLOOMBERG_IV[tk];
  if(iv==null || !CUR.spot) return null;
  CUR._tenor = tenor||3;
  const Tt=bsTenorT(tenor||3);
  const targetCoupon = coupon;
  const f=(sk)=>{ const {beta,cb}=bsBeta(tk, sk, iv);
    return beta*bsMid(CUR.spot, sk, Tt, BS_R, iv) + cb*(call-100)/10 - bsMbAdj(mb) - targetCoupon; };
  let lo=0.30, hi=0.99;
  const fLo=f(lo), fHi=f(hi);
  if(fLo>0 && fHi>0) return {put:+(hi*100).toFixed(2), coupon, src:"BS (Bloomberg IV)"};
  if(fLo<0 && fHi<0) return {put:+(lo*100).toFixed(2), coupon, src:"BS (Bloomberg IV)"};
  for(let i=0;i<60;i++){ const mid=(lo+hi)/2; if(f(mid)>0) hi=mid; else lo=mid; }
  let sk=(lo+hi)/2;
  const ff = BS_FREQ_FACTOR[cfreq]!=null ? BS_FREQ_FACTOR[cfreq] : 1.0;
  sk = Math.min(0.99, Math.max(0.30, sk*ff));   // annual -> lower strike
  return {put:+(sk*100).toFixed(2), coupon, src:"BS (Bloomberg IV)"};
}

// ---- solve coupon from put (single stock) ----
function calibBsSingleCoupon(ticker, put, mb, call, tenor, cfreq){
  const tk=normSym(ticker); const iv=BLOOMBERG_IV[tk];
  if(iv==null || !CUR.spot) return null;
  CUR._tenor = tenor||3;
  const Tt=bsTenorT(tenor||3);
  let sk=put/100;
  const ff = BS_FREQ_FACTOR[cfreq]!=null ? BS_FREQ_FACTOR[cfreq] : 1.0;
  sk = sk/ff;   // invert freq shift to get BS strike
  sk = Math.min(0.99, Math.max(0.30, sk));
  const {beta,cb}=bsBeta(tk, sk, iv);
  const coupon = beta*bsMid(CUR.spot, sk, Tt, BS_R, iv) + cb*(call-100)/10 - bsMbAdj(mb);
  return {put, coupon:+Math.max(coupon,0).toFixed(2), src:"BS (Bloomberg IV)"};
}

// ---- basket worst-of: driver = highest-IV component ----
function bsBasketDriver(syms){
  let drv=null, best=-1;
  syms.forEach(s=>{ const tk=normSym(s); const iv=BLOOMBERG_IV[tk]; if(iv!=null && iv>best){best=iv;drv=tk;} });
  return drv;
}
function calibBsBasketPut(syms, coupon, mb, call, tenor, cfreq){
  const drv=bsBasketDriver(syms);
  if(!drv) return null;            // no Bloomberg IV for any component → fallback to old model
  return calibBsSinglePut(drv, coupon, mb, call, tenor, cfreq);
}
function calibBsBasketCoupon(syms, put, mb, call, tenor, cfreq){
  const drv=bsBasketDriver(syms);
  if(!drv) return null;
  return calibBsSingleCoupon(drv, put, mb, call, tenor, cfreq);
}
