# GTM & gtag Inspector（Arc / Chrome extension）

一個 Manifest V3 擴充功能，用嚟檢查網頁上嘅 Google Tag Manager、gtag.js、dataLayer，同埋 GA4 / Google Ads / Floodlight 發出嘅 hits。支援 Arc、Chrome、Edge、Brave 等 Chromium 瀏覽器。

## 功能

- **Overview**：偵測頁面上嘅 GTM-、G-、AW-、DC-、GT-、UA- ID（來源包括 `google_tag_manager`、`<script>` 標籤、noscript snippet、`gtag('config')`、網絡請求），會顯示 library 有冇 load 到、係咪 first-party（server-side GTM），同埋每個 ID 有幾多 hits。撳張卡就會篩選出嗰個 ID 嘅 hits。
- **Consent mode**：讀取 `gtag('consent', 'default' | 'update')`，再解讀最新 hit 嘅 `gcs` 值。
- **Hits**：即時顯示 GA4（包括 batch 喺 POST body 入面嘅多個 events）、UA、Google Ads conversion / remarketing、Floodlight、Google tag `ccm/collect`。GA4 參數會分組顯示：Event、Event parameters、Items（自動解碼 `pr1`）、User properties、Consent，同埋其他系統參數，每個參數都有標籤說明。
- **dataLayer**：每次 `dataLayer.push()` / `gtag()` 呼叫都會記錄，以有語法高亮嘅 JSON 顯示（自訂 dataLayer 名都支援）。
- **Timeline**：所有嘢按時間排列，包括頁面導航同 SPA history 變化。
- Filter、Preserve log（跨頁保留紀錄）、Copy JSON / URL、Export 成 JSON。
- 工具列 icon 上嘅 badge 會顯示呢頁嘅 hits 數量。
- 亦有 **DevTools panel**（DevTools → 「GTM Inspector」分頁），用嘅係同一個 UI。

## 喺 Arc 安裝

1. 喺 Arc 打開 `arc://extensions`（或者 `chrome://extensions`）
2. 開咗右上角嘅 **Developer mode**
3. 撳 **Load unpacked**，揀呢個資料夾 `gtm-gtag-inspector`
4. 喺 Arc 撳網址列右邊嘅 extensions 圖示（或者側邊欄頂部嘅 `⋯` → Extensions），將 **GTM & gtag Inspector** pin 起
5. 之後打開或者 reload 一個有 GTM 嘅網頁，再撳個 icon

> 裝完之後，已經開咗嘅分頁要 **reload** 一次，dataLayer 監察先會生效（網絡 hits 就即刻已經會捕捉到）。

## 結構

```
manifest.json          MV3 manifest
background.js          Service worker：用 webRequest 捕捉 hits、解析、按分頁儲存狀態
content/inject.js      MAIN world script：監察 dataLayer、偵測 containers
content/bridge.js      Isolated world 中轉：將頁面訊息轉交 background
ui/                    Popup 同 DevTools panel 共用嘅介面
devtools/              DevTools panel 註冊
icons/                 圖示
```

## 備註

- 只係觀察請求（非 blocking `webRequest`），唔會修改或者攔截任何 tracking。
- 數據存喺 `chrome.storage.session`，瀏覽器關閉就會清走；每個分頁最多保留 600 個事件。
- Server-side GTM（例如 `sgtm.example.com/g/collect`）會按路徑辨認，並標示為 first-party。
