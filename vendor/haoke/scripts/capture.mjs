// 抓题：逐题截图 + 题面文字存档，直到「下一题」变灰
// 用法：node capture.mjs --out <输出目录> [--stem-selector 选择器] [--max 60]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  getPuppeteer, launchBrowser, getPage, releaseBrowser, sleep, waitForPractice, currentCell,
  cardGoto, nextBtnState, clickNext, stemText, STEM_DEFAULT, SITE_URL, arg,
} from "./haoke-common.mjs";

const outDir = path.resolve(arg("out", "./_抓题"));
const stemSel = arg("stem-selector", STEM_DEFAULT);
const maxN = parseInt(arg("max", "60"), 10);
mkdirSync(outDir, { recursive: true });

const puppeteer = await getPuppeteer();
const browser = await launchBrowser(puppeteer);
try {
  const page = await getPage(browser);
  await page.goto(SITE_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
  await waitForPractice(page, stemSel);
  await page.setViewport({ width: 1280, height: 2160, deviceScaleFactor: 2 });
  await sleep(600);

  let n = parseInt(await currentCell(page), 10);
  if (!Number.isFinite(n) || n < 1) n = 1;
  console.log(`开始抓取：从第 ${n} 题，输出到 ${outDir}`);

  const texts = [];
  let done = 0,
    stopped = "";
  while (n <= maxN) {
    await page.waitForSelector(stemSel, { timeout: 8000 });
    const rect = await page.evaluate((s) => {
      const c = document.querySelector(s);
      const r = c.getBoundingClientRect();
      return { x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height };
    }, stemSel);
    const pad = 10,
      padB = 2;
    const file = path.join(outDir, `第${String(n).padStart(2, "0")}题.png`);
    await page.screenshot({
      path: file,
      captureBeyondViewport: true,
      clip: {
        x: Math.max(0, rect.x - pad),
        y: Math.max(0, rect.y - pad),
        width: rect.w + pad * 2,
        height: rect.h + pad + padB,
      },
    });
    const text = await stemText(page, stemSel);
    texts.push({ n, text });
    writeFileSync(path.join(outDir, "题面文本.json"), JSON.stringify(texts, null, 1));
    console.log(`第${String(n).padStart(2, "0")}题 OK`);
    done = n;

    const btn = await nextBtnState(page);
    if (!btn || btn.disabled) {
      stopped = `第${n}题处「下一题」已变灰，作业结束`;
      break;
    }

    const prev = text;
    await clickNext(page);
    let ok = false;
    for (let t = 0; t < 10; t++) {
      await sleep(400);
      if ((await currentCell(page)) === String(n + 1)) {
        ok = true;
        break;
      }
      if (t === 4) await cardGoto(page, n + 1);
    }
    if (!ok) {
      stopped = `导航到第${n + 1}题失败`;
      break;
    }
    for (let t = 0; t < 12; t++) {
      await sleep(350);
      const t2 = await stemText(page, stemSel);
      if (t2 && t2 !== prev) {
        await sleep(300);
        break;
      }
    }
    n++;
  }
  console.log(stopped || `到达题数上限 ${maxN}`);
  console.log(`DONE ${done} 张 -> ${outDir}`);
} finally {
  releaseBrowser(browser);
}
