# vendor/ — 随仓库分发的流水线脚本副本

独立克隆本仓库时的运行依赖（面板优先使用相邻 skill 安装的原版脚本，找不到时回退到这里）。
首次运行会自动在各自 `scripts/` 目录里 `npm install`（mathjax / puppeteer-core）。

| 目录 | 来源 skill | 用途 |
|---|---|---|
| haoke/ | sjtu-aihaoke-automation | 抓题 capture.mjs、上传 upload.mjs、清理 hw_clean.py |
| split/ | sjtu-hw-split | 拆行 prepare.py、切图 cut.py（+ hw_geom.py） |
| latex/ | sjtu-hw-to-latex | 拆页 hw_pdf.py、渲染 hw_render.py |
| check/ | sjtu-hw-check | 量行 locate.py、红笔合成 redpen.py（+ snip.js） |

原版 skill 更新后需手动同步副本。
