# 文字圖層用 Satori 產 PNG，不靠 ffmpeg 畫字

短影片的標題卡、字幕、數字強調都需要在畫面上寫字，最直覺的做法是把字幕編成 ASS 交給 ffmpeg 燒錄。但開發機上的 ffmpeg 8.1（Homebrew）**沒有編入 freetype、libass、fontconfig、harfbuzz**，`drawtext`、`subtitles`、`ass` 三個 filter 全部不存在，該方案在這台機器上無法執行。我們改為在 Node 內用 Satori（JSX/flexbox → SVG）加 resvg-js（SVG → PNG）產生透明文字圖層，再由 ffmpeg 的 `overlay` 疊上；ffmpeg 只負責解碼、裁切、縮放、變速、拼接、編碼，完全不碰文字。

## Considered Options

- **重裝完整版 ffmpeg**（`homebrew-ffmpeg` tap 帶 `--with-libass`）：一行指令就能讓 ASS 方案復活，但把工具鏈的正確性押在系統套件的編譯選項上——Homebrew 日後更新有機會靜悄悄換回精簡版，管線會在沒有任何警告的情況下壞掉。
- **Remotion**：React 渲染，排版能力最強，但它會把**每一幀**送進 headless Chrome；本專案真正需要瀏覽器級排版的只有那 20–30 張靜態圖層，為此付出分鐘級渲染時間與一個 Chrome 依賴並不划算。

## Consequences

- 工具鏈完全鎖在 `package.json` 內，不依賴使用者的系統環境。ffmpeg 只需要最基本的 filter 集合（已確認 `crop` / `scale` / `overlay`（含 timeline 支援）/ `setpts` / `concat` / `hstack` / `drawbox` 皆可用）。
- 中文排版（每行 12–16 字、不在標點前斷行）與數字強調（`+1.8R`、`4,038.2` 加粗變色）由 flexbox 描述，比 ASS 標籤精確，且與使用者既有的 React/TS 技術棧一致。
- 文字圖層是靜態 PNG，可直接開啟檢視與快取，調版面不必渲染影片。
- 代價：多兩個 npm 依賴，以及一層自建的文字渲染模組。字幕變化約 2–3 秒一次，整支片約 20–30 張不重複圖層，組成一條字幕軌後單次 overlay，不會讓 filter graph 爆炸。
