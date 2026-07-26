// ELN Pricer — REAL FinIQ calibration table
// 全部係 Kathy 由 FinIQ 抄出嚟嘅真實 indicative（合規：人手抄報價，非自動抓）。
// 結構：90 call, 3M, T+1week。put = strike level (% of initial spot)。
// Solver 優先用呢個表（exact match 內插），冇 match 先跌返 IV heuristic。

const CALIB = {
  // ---- 美股單一股：8% client coupon, 90call, 3M, MB1% 之 put strike ----
  us_single_8pct_mb1: {
    CRDO:38, ALAB:38, SNDK:38, SKHY:38,   // "<40" → 用 38 approx
    LITE:40, LRCX:40, KLAC:41, MU:41, AMAT:42, COHR:42,
    MRVL:44, INTC:44, ASX:49, DELL:49, AMD:51, SOXX:57
  },
  // SNDK 第二錨點：20% coupon → 45 put（用嚟定 coupon↔strike 斜率）
  // slope = (45-38)/(20-8) = 0.583 put per 1% client coupon
  us_slope: 0.583,
  us_anchor_coupon: 8,

  // ---- 港股單一股 strike（90 call；coupon 待確認，暫存作參考） ----
  hk_single_ref: {
    "992":64, "9992":76, "9988":77, "3690":75, "1211":80,
    "9999":83, "700":85, "5":90, "2388":91.5
  },

  // ---- 港股 basket (worst-of)，90call, 3M, T+1week ----
  // key = 成分股 sorted join "+"；每個 {mb: {clientCoupon: put}}
  hk_basket: {
    "3690+992": { "1": {10:64, 12:66}, "2": {10:71} },
    "9618+992": { "1": {10:66, 12:68} },
    "9992+992": { "1": {10:64, 12:66}, "2": {10:71} },
    "1211+992": { "1": {10:65, 12:67}, "2": {10:73} },
    "1347+992": { "1": {10:52, 12:53} }
  },
  // 港股 basket MB 敏感度（由 3690+992: MB1→MB2 @10% = 64→71 推算）≈ 7p / 1% MB
  hk_basket_mb_slope: 7,
  // 港股 basket coupon 敏感度（10%→12% = +2p over 2% = 1p / 1%）
  hk_basket_cpn_slope: 1
};

// ---- helpers ----
function basketKey(syms){
  return syms.map(s=>String(s).replace(/\.HK$/i,"").replace(/^0+/,"")).sort().join("+");
}
function normSym(s){ return String(s).toUpperCase().replace(/\.HK$/i,"").replace(/^0+/,""); }

// US single: solve put from coupon (mb-adjusted via gross)
function calibUsPut(stock, clientCoupon, mb){
  const t=CALIB.us_single_8pct_mb1[normSym(stock)];
  if(t==null) return null;
  // gross drives strike; anchor is 8% client @ mb1 → gross 9%
  const grossRef = CALIB.us_anchor_coupon + 1;      // 9
  const gross = clientCoupon + mb;
  return +(t + CALIB.us_slope*(gross - grossRef)).toFixed(2);
}
function calibUsCoupon(stock, put, mb){
  const t=CALIB.us_single_8pct_mb1[normSym(stock)];
  if(t==null) return null;
  const grossRef = CALIB.us_anchor_coupon + 1;
  const gross = grossRef + (put - t)/CALIB.us_slope;
  return +(gross - mb).toFixed(2);                    // client = gross - mb
}

// HK basket: interpolate from table
function calibHkBasketPut(syms, clientCoupon, mb){
  const k=basketKey(syms);
  const row=CALIB.hk_basket[k]; if(!row) return null;
  const mbKey = String(Math.round(mb));
  let base=row[mbKey], usedMb=mb;
  if(!base){ // use MB1 as base, adjust
    base=row["1"]; usedMb=1;
    if(!base) return null;
  }
  // interpolate coupon within base (has 10 &/or 12)
  const cs=Object.keys(base).map(Number).sort((a,b)=>a-b);
  let put;
  if(base[clientCoupon]!=null) put=base[clientCoupon];
  else if(cs.length>=2){
    const [c0,c1]=[cs[0],cs[cs.length-1]];
    put=base[c0]+(base[c1]-base[c0])*(clientCoupon-c0)/(c1-c0);
  } else {
    put=base[cs[0]]+CALIB.hk_basket_cpn_slope*(clientCoupon-cs[0]);
  }
  if(usedMb!==mb) put += CALIB.hk_basket_mb_slope*(mb-usedMb);
  return +put.toFixed(2);
}
function calibHkBasketCoupon(syms, put, mb){
  const k=basketKey(syms);
  const row=CALIB.hk_basket[k]; if(!row) return null;
  const mbKey=String(Math.round(mb));
  let base=row[mbKey], usedMb=mb;
  if(!base){ base=row["1"]; usedMb=1; if(!base) return null; }
  let p=put; if(usedMb!==mb) p -= CALIB.hk_basket_mb_slope*(mb-usedMb);
  const cs=Object.keys(base).map(Number).sort((a,b)=>a-b);
  if(cs.length>=2){
    const [c0,c1]=[cs[0],cs[cs.length-1]];
    return +(c0+(c1-c0)*(p-base[c0])/(base[c1]-base[c0])).toFixed(2);
  }
  return +(cs[0]+(p-base[cs[0]])/CALIB.hk_basket_cpn_slope).toFixed(2);
}
