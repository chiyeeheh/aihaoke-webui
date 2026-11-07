// 把 htmlDir 里每个片段页只截 #snip 这一个元素，保留透明背景，输出 PNG。
// 由 redpen.py 调用，一般不用手跑。
//
//   node snip.js <jobs.json>
//   jobs.json: {chrome, htmlDir, outDir, scale, only?}
//     only  只截这些文件名（不含 .html），不给就全截
//
// 依赖：本目录下的 node_modules（puppeteer-core）。缺失时 redpen.py 会先 npm install。
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const puppeteer = require(path.join(__dirname, 'node_modules', 'puppeteer-core'));

(async () => {
  const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const { chrome, htmlDir, outDir, scale } = cfg;
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none'],
  });

  const only = cfg.only ? new Set(cfg.only) : null;
  const files = fs.readdirSync(htmlDir)
    .filter(f => f.endsWith('.html'))
    .filter(f => !only || only.has(f.replace(/\.html$/, '')))
    .sort();
  for (const f of files) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 600, deviceScaleFactor: scale });
    await page.goto(pathToFileURL(path.join(htmlDir, f)).href, {
      waitUntil: 'networkidle0', timeout: 60000,
    });
    await page.evaluate(() => window.MathJax.startup.promise);
    await new Promise(r => setTimeout(r, 250));

    const el = await page.$('#snip');
    if (!el) { console.log(`MISS ${f}`); await page.close(); continue; }
    const box = await el.boundingBox();
    const out = path.join(outDir, f.replace(/\.html$/, '.png'));
    await el.screenshot({ path: out, omitBackground: true });
    console.log(`OK ${f} ${Math.round(box.width)}x${Math.round(box.height)} ${out}`);
    await page.close();
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
