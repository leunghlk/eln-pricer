# Cloudflare Worker 部署指南（俾 Kathy）

呢個 Worker 係你嘅**免費數據代理**，一次過解決：
- ✅ 港股 + 美股真實 K 線（GitHub Pages hosted 版都 fetch 到）
- ✅ 自動 option IV（唔使再手動抄 IV 俾我 —— 你嘅 #7）

Cloudflare Worker 免費層：**每日 100,000 次請求**，你日常用綽綽有餘。

---

## 步驟（用網頁介面，唔使裝任何嘢）

### 1. 入去 Workers
- 登入 https://dash.cloudflare.com（你已用 Gmail 開咗 account）
- 左邊菜單撳 **Compute (Workers)** 或 **Workers & Pages**
- 撳 **Create application**（或 **Create Worker**）
- 如果彈 workers.dev 子域設定，隨便改個名（例如 `kathyleung`），撳確認。之後你條 Worker URL 會係 `https://<worker名>.kathyleung.workers.dev`

### 2. 建立 Worker
- 撳 **Create Worker**
- 個名改做：**`eln-proxy`**
- 撳 **Deploy**（佢會先 deploy 一個預設 hello-world）

### 3. 貼上真正 code
- Deploy 完之後撳 **Edit code**（或 **</> Edit code**）
- 將編輯器**全部內容清空**
- 打開檔案 `worker.js`（喺 /Users/leungkathy/eln-dashboard/worker.js），**全選複製，貼入去**
- 撳右上角 **Deploy**（或 **Save and deploy**）

### 4. 攞你條 Worker URL
- Deploy 成功後，頁面會顯示條 URL，例如：
  `https://eln-proxy.kathyleung.workers.dev`
- **複製呢條 URL**

### 5. 話我知條 URL
- 將條 Worker URL 貼返俾我
- 我會填入 dashboard 個 `data.js`，然後 push
- 之後你個 pricer 就會用真實 Yahoo 數據（港股美股 K 線 + 自動 IV）

---

## 測試（可選，貼俾我之前自己試）
喺瀏覽器開：
- `https://<你的worker>.workers.dev/chart?symbol=AAPL&range=1mo`
  → 應該見到一大堆 JSON（AAPL 股價數據）
- `https://<你的worker>.workers.dev/chart?symbol=0700.HK&range=1mo`
  → 港股騰訊數據
- `https://<你的worker>.workers.dev/options?symbol=SNDK`
  → SNDK 期權鏈（含 impliedVolatility）

見到 JSON 就成功。
