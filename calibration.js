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
  hk_single_cpn_slope: 1.5,   // +1.5p strike per +1% coupon
  hk_single_mb_slope: 7,      // +7p strike per +1% MB

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
  hk_basket_cpn_slope: 1,

  // ---- 美股 basket (worst-of) 真實報價記錄 ----
  // key = 成分股 sorted join "+"；array of {tenor(月), call%, mb%, coupon%, put%}
  us_basket: {
    "DELL+SNDK": [
      {tenor:2, call:100, mb:3, coupon:18, put:51},
      {tenor:2, call:90,  mb:3, coupon:18, put:51},
      {tenor:2, call:80,  mb:3, coupon:18, put:51},
      {tenor:2, call:70,  mb:3, coupon:18, put:54}
    ],
    "INTC+SNDK": [
      {tenor:2, call:100, mb:3, coupon:18, put:55},
      {tenor:2, call:90,  mb:3, coupon:18, put:54},
      {tenor:2, call:80,  mb:3, coupon:18, put:55},
      {tenor:2, call:70,  mb:3, coupon:18, put:58}
    ],
    "AMAT+SNDK": [
      {tenor:24, call:95.5, mb:4.5, coupon:25, put:55.5,  bank:"UBS"},
      {tenor:24, call:95,   mb:5,   coupon:25, put:57.24, bank:"UBS"}
    ]
  }
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

function calibHkSinglePut(stock, clientCoupon, mb){
  const s=normSym(stock); const ref=CALIB.hk_single_ref[s];
  if(ref==null) return null;
  // table value is strike% at 8% client coupon, MB1 (user-confirmed basis).
  const couponRef=8, mbRef=1;
  let put = ref + (clientCoupon-couponRef)*CALIB.hk_single_cpn_slope
                 + (mb-mbRef)*CALIB.hk_single_mb_slope;
  return +put.toFixed(2);
}
function calibHkSingleCoupon(stock, put, mb){
  const s=normSym(stock); const ref=CALIB.hk_single_ref[s];
  if(ref==null) return null;
  // reverse of calibHkSinglePut: strip MB effect first, then coupon slope
  const m=(mb==null?1:mb);
  return +(8 + (put - ref - (m-1)*CALIB.hk_single_mb_slope)/CALIB.hk_single_cpn_slope).toFixed(2);
}

// ---- HK basket DERIVED from single table (covers ALL combinations) ----
// Rule (reverse-engineered from real quotes):
//   basket worst-of put ≈ min(component single strikes @8%) shifted by
//   (coupon - 8 - premium) * cpn_slope + (mb-1) * mb_slope
//   premium = 2% for 2 stocks, +1% per extra stock (worst-of pays more coupon).
// Verified: 992+3690 @10% mb1 → 64 (table 64 ✓), @mb2 → 71 (table 71 ✓),
//           992+1211 @10% mb1 → 64 (table 65, ±1), @12% → 66 (table 67, ±1)
function calibHkBasketDerivedPut(syms, clientCoupon, mb){
  const refs=syms.map(s=>CALIB.hk_single_ref[normSym(s)]);
  if(refs.some(r=>r==null)) return null;   // any unknown component → cannot derive
  const n=syms.length;
  const base=Math.min(...refs);            // highest-vol name (lowest strike) drives
  const premium=2+(n-2);                   // 2股=2%, 3股=3%
  const put = base + (clientCoupon-8-premium)*CALIB.hk_basket_cpn_slope
                   + (mb-1)*CALIB.hk_basket_mb_slope;
  return +put.toFixed(2);
}
function calibHkBasketDerivedCoupon(syms, put, mb){
  const refs=syms.map(s=>CALIB.hk_single_ref[normSym(s)]);
  if(refs.some(r=>r==null)) return null;
  const n=syms.length;
  const base=Math.min(...refs);
  const premium=2+(n-2);
  const c = 8+premium + (put - base - (mb-1)*CALIB.hk_basket_mb_slope)/CALIB.hk_basket_cpn_slope;
  return +c.toFixed(2);
}

// US basket (worst-of): match nearest real quote by tenor+mb, interp on call
function _usBasketRow(syms){ return CALIB.us_basket[basketKey(syms)]||null; }
function _nearest(rows, tenor, mb){
  // rank by |tenor diff| then |mb diff|
  return rows.slice().sort((a,b)=>
    (Math.abs(a.tenor-tenor)-Math.abs(b.tenor-tenor))||
    (Math.abs(a.mb-mb)-Math.abs(b.mb-mb)))[0];
}
function _interpByCall(rows, call){
  // rows share tenor/mb group; interpolate put on call level
  const ex=rows.find(r=>Math.abs(r.call-call)<0.01);
  if(ex)return {put:ex.put, coupon:ex.coupon, ref:ex};
  const sorted=rows.slice().sort((a,b)=>a.call-b.call);
  const lo=sorted.filter(r=>r.call<=call).pop();
  const hi=sorted.find(r=>r.call>=call);
  if(lo&&hi&&lo!==hi){
    const f=(call-lo.call)/(hi.call-lo.call);
    return {put:+(lo.put+(hi.put-lo.put)*f).toFixed(2), coupon:lo.coupon, ref:lo};
  }
  const one=lo||hi||sorted[0];
  return {put:one.put, coupon:one.coupon, ref:one};
}
function calibUsBasketPut(syms, clientCoupon, mb, tenor, call){
  const rows=_usBasketRow(syms); if(!rows)return null;
  const grp=_nearest(rows,tenor,mb);
  const same=rows.filter(r=>r.tenor===grp.tenor&&r.mb===grp.mb);
  const {put,coupon,ref}=_interpByCall(same, call);
  // GROSS-based adjustment: quote gross = coupon+quote.mb; target gross = clientCoupon+mb.
  // +0.5p put per +1% gross above quote (worst-of skew). MB↑ (same client coupon) → gross↑ → put↑.
  const adj=((clientCoupon+mb)-(coupon+grp.mb))*0.5;
  return {put:+(put+adj).toFixed(2), quoteCoupon:coupon, tenor:grp.tenor, mb:grp.mb, bank:ref.bank};
}
function calibUsBasketCoupon(syms, put, mb, tenor, call){
  const rows=_usBasketRow(syms); if(!rows)return null;
  const grp=_nearest(rows,tenor,mb);
  const same=rows.filter(r=>r.tenor===grp.tenor&&r.mb===grp.mb);
  const {put:qPut,coupon}=_interpByCall(same, call);
  // gross from put diff, then client = gross - user mb. MB↑ → client coupon↓.
  const gross=(coupon+grp.mb)+(put-qPut)/0.5;
  return {coupon:+(gross-mb).toFixed(2), quotePut:qPut, tenor:grp.tenor, mb:grp.mb};
}
