# 文字圖層在 Node 內產成 PNG，不靠 ffmpeg 畫字

短影片不帶講者原聲，敘事全部由畫面上的文字承載，所以文字渲染是主要功能而非配件。最直覺的做法是把字幕編成 ASS 交給 ffmpeg 燒錄，但開發機上的 ffmpeg 8.1（Homebrew）**沒有編入 freetype、libass、fontconfig、harfbuzz**，`drawtext`、`subtitles`、`ass` 三個 filter 全部不存在，該方案在這台機器上無法執行。我們改為在 Node 內把文字排版成 SVG、以 resvg 光柵化成透明 PNG，再由 ffmpeg 的 `overlay` 疊上；ffmpeg 只負責解碼、裁切、縮放、變速、拼接、混音、編碼，完全不碰文字。

## Considered Options

- **重裝完整版 ffmpeg**（`homebrew-ffmpeg` tap 帶 `--with-libass`）：一行指令就能讓 ASS 方案復活，但把工具鏈的正確性押在系統套件的編譯選項上——Homebrew 日後更新有機會靜悄悄換回精簡版，管線會在沒有任何警告的情況下壞掉。
- **Satori（JSX/flexbox → SVG）加 resvg**：原本的設計。實作時發現不需要：本專案的版面只有「置中的一到三行字」，用不到 flexbox 排版引擎，而 Satori 必須餵入字型 buffer——中文字型動輒十幾 MB，等於要把二進位資產放進版控或在執行期下載。**改為直接手寫 SVG 交給 resvg，並讓 resvg 使用系統字型**，少一個相依也少一個資產。
- **Remotion**：React 渲染，排版能力最強，但它會把**每一幀**送進 headless Chrome；本專案真正需要瀏覽器級排版的只有那二十來張靜態圖層，為此付出分鐘級渲染時間與一個 Chrome 依賴並不划算。

## Consequences

- 工具鏈完全鎖在 `package.json` 內，不依賴使用者的系統環境。ffmpeg 只需要基本的 filter 集合（已確認 `crop` / `scale` / `overlay`（含 timeline 支援）/ `setpts` / `concat` / `hstack` / `pad` / `sine` / `amix` / `afade` / `alimiter` 皆可用）。
- **依賴系統字型是刻意的取捨。** 好處是不必打包中文字型；代價是換一台沒有該字型的機器會 fallback 成別的字體。這是個人工具，可接受；真的要跨機器一致時，改為指定字型檔即可，resvg 兩種都支援。
- 中文排版（每行字數、不在標點前斷行）與數字強調（`+1.8R`、`4,038.2` 加粗變色）由自己的程式控制，比 ASS 標籤精確。數字比對需要否定回顧來排除 `TP1`、`TP2` 這類標籤裡的序號，否則序號會被誤染成價位。
- 文字圖層是靜態 PNG，可直接開啟檢視，調版面不必渲染影片。
- 每張卡佔一個 ffmpeg 輸入並串接一次 `overlay`。二十來張卡的濾鏡圖仍在可讀範圍內；若日後張數大幅增加，需要改為先合成單一字幕軌再一次疊上。
