// 上传：把「第n题.png」切片逐题传到作业作答区，每题传完点「下一题」
// 用法：node upload.mjs --dir <切片目录> [--url 作业URL] [--stem-selector 选择器] [--max 60] [--force]
// 结束后浏览器保持打开（登录态留到下次），绝不调用 browser.close()。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  getPuppeteer, launchBrowser, getPage, releaseBrowser, sleep, waitForPractice, currentCell,
  cardGoto, nextBtnState, clickNext, gotoQuestion, STEM_DEFAULT, SITE_URL, arg,
} from "./haoke-common.mjs";

const imgDir = path.resolve(arg("dir", "./图片"));
const stemSel = arg("stem-selector", STEM_DEFAULT);
const maxN = parseInt(arg("max", "60"), 10);
const force = process.argv.includes("--force");
const startUrl = arg("url", SITE_URL);
if (!existsSync(imgDir)) {
  console.error(`切片目录不存在：${imgDir}`);
  process.exit(1);
}
const files = new Map();
for (const f of readdirSync(imgDir)) {
  const m = /^第(\d+)题\.png$/.exec(f);
  if (m) files.set(parseInt(m[1], 10), path.join(imgDir, f));
}
if (!files.size) {
  console.error("目录里没有匹配「第n题.png」的切片文件");
  process.exit(1);
}
console.log(`共 ${files.size} 个切片，题号：${[...files.keys()].sort((a, b) => a - b).join(",")}`);

const puppeteer = await getPuppeteer();
const browser = await launchBrowser(puppeteer);
try {
  const page = await getPage(browser);
  await page.goto(startUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  await waitForPractice(page, stemSel);

  const first = Math.min(...files.keys());
  await cardGoto(page, first);
  await sleep(1000);

  const results = [];
  for (const [n, file] of [...files.entries()].sort((a, b) => a[0] - b[0])) {
    if (n > maxN) break;
    if ((await currentCell(page)) !== String(n)) await cardGoto(page, n);
    await page.waitForSelector(stemSel, { timeout: 8000 }).catch(() => {});
    await sleep(300);

    const name = `第${n}题.png`;
    const existing = await page.evaluate((nm) =>
      [...document.querySelectorAll(".new-com-upload-list-item")].some((e) =>
        (e.textContent || "").includes(nm)
      ), name);
    if (existing && !force) {
      console.log(`第${n}题 已有附件，跳过（--force 可重传）`);
      results.push(`${n}:skip`);
    } else {
      const b64 = readFileSync(file).toString("base64");
      await page.evaluate((data) => {
        const bin = atob(data.b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const f = new File([bytes], data.name, { type: "image/png" });
        const input = document.querySelector("input.el-upload__input");
        if (!input) throw new Error("找不到上传控件 input.el-upload__input");
        const dt = new DataTransfer();
        dt.items.add(f);
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }, { name, b64 });
      let ok = false;
      for (let t = 0; t < 12; t++) {
        await sleep(500);
        ok = await page.evaluate((nm) => {
          const item = [...document.querySelectorAll(".new-com-upload-list-item")].find(
            (e) => (e.textContent || "").includes(nm)
          );
          return !!item && String(item.className).includes("success");
        }, name);
        if (ok) break;
      }
      console.log(`第${n}题 上传${ok ? "OK" : "FAIL"}`);
      results.push(`${n}:${ok ? "OK" : "FAIL"}`);
    }

    const btn = await nextBtnState(page);
    if (!btn || btn.disabled) {
      console.log("「下一题」已变灰，结束");
      break;
    }
    await clickNext(page);
    try {
      // gotoQuestion 内含答题卡兜底
      await gotoQuestion(page, n + 1);
    } catch (e) {
      console.log(`警告：${e.message}，下一循环会用答题卡纠正`);
    }
  }
  console.log("DONE " + results.join(" "));
} finally {
  releaseBrowser(browser);
  console.log("上传结束。请在浏览器中检查后自行提交，不要关闭这个窗口。");
}
