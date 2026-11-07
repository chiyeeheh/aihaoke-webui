// haoke 平台（sjtu.aihaoke.net）抓题/上传共用工具
// 脚本驱动本机 Chrome/Edge（带持久登录档案），一切翻页、截图、上传均为确定性操作；
// 大模型只在「题面元素定位失败」时出场去识别新的选择器（用 --stem-selector 传入）。
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROFILE_DIR = path.join(__dirname, ".chrome-profile");

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe")
    : null,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean);

export function findChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  throw new Error(
    "找不到 Chrome/Edge。请安装，或用环境变量 CHROME_PATH 指定浏览器可执行文件路径。"
  );
}

export async function getPuppeteer() {
  if (!existsSync(path.join(__dirname, "node_modules", "puppeteer-core"))) {
    console.log("首次运行：安装 puppeteer-core（几秒到一分钟）…");
    const r = spawnSync(
      "npm",
      ["install", "puppeteer-core", "--no-fund", "--no-audit", "--prefix", __dirname],
      { stdio: "inherit", shell: true }
    );
    if (r.status !== 0) throw new Error("npm install 失败，请检查网络后重试");
  }
  const require = createRequire(path.join(__dirname, "noop.js"));
  return require("puppeteer-core");
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const STEM_DEFAULT = ".quiz-title-content .parse-markdown";
export const SITE_URL = "https://sjtu.aihaoke.net/";

// 固定调试端口：脚本结束后 Chrome 不关，下次运行用 puppeteer.connect 直接接上同一个窗口，
// 登录态一直保留。端口被占用时可用环境变量 HAOKE_DEBUG_PORT 改。
export const DEBUG_PORT = parseInt(process.env.HAOKE_DEBUG_PORT || "9222", 10);
const DEBUG_URL = `http://127.0.0.1:${DEBUG_PORT}`;

export function arg(name, fallback = undefined) {
  const i = process.argv.indexOf("--" + name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

export async function launchBrowser(puppeteer) {
  try {
    const browser = await puppeteer.connect({
      browserURL: DEBUG_URL,
      defaultViewport: null,
    });
    console.log("复用已打开的 Chrome（登录态保留，无需重新登录）。");
    return browser;
  } catch {}
  return puppeteer.launch({
    executablePath: findChrome(),
    headless: false,
    defaultViewport: null,
    userDataDir: PROFILE_DIR,
    // 关掉 puppeteer 的信号处理：脚本被中断时也不许顺手杀掉 Chrome
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    args: [
      "--start-maximized",
      "--disable-blink-features=AutomationControlled",
      `--remote-debugging-port=${DEBUG_PORT}`,
    ],
  });
}

// 优先复用 haoke 标签页，避免接到用户的其它标签
export async function getPage(browser) {
  const pages = await browser.pages();
  return (
    pages.find((p) => (p.url() || "").includes("aihaoke.net")) ||
    pages[0] ||
    (await browser.newPage())
  );
}

// 任务结束只断开连接，绝不关闭 Chrome —— 登录态必须留给下一次运行
export function releaseBrowser(browser) {
  try {
    browser.disconnect();
  } catch {}
  console.log("浏览器保持打开（登录态已保留），下次运行会自动复用。");
}

// 等待用户在浏览器里登录并进入作业作答页（URL 含 /practice 且题面元素存在）
export async function waitForPractice(page, stemSel, timeoutMs = 10 * 60_000) {
  console.log("请在打开的浏览器窗口中登录（jAccount），并打开到作业的作答页面（看到题目）…");
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const ok = await page.evaluate(
        (sel) => location.href.includes("/practice") && !!document.querySelector(sel),
        stemSel
      );
      if (ok) return;
    } catch {}
    await sleep(1500);
  }
  throw new Error("等待超时：10 分钟内未进入作业作答页。请重跑脚本。");
}

export const currentCell = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".answer-sheet-item.current")]
      .map((e) => e.textContent.trim())
      .join(",")
  );

export async function cardGoto(page, n) {
  await page.evaluate((num) => {
    const el = [...document.querySelectorAll(".answer-sheet-item")].find(
      (e) => e.textContent.trim() === String(num)
    );
    if (el) el.click();
  }, n);
}

export const nextBtnState = (page) =>
  page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) =>
      (x.textContent || "").includes("下一题")
    );
    return b ? { disabled: b.disabled } : null;
  });

export const clickNext = (page) =>
  page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) =>
      (x.textContent || "").includes("下一题")
    );
    if (b && !b.disabled) b.click();
  });

export const stemText = (page, sel) =>
  page.evaluate((s) => {
    const c = document.querySelector(s);
    return c ? c.innerText : "";
  }, sel);

// 翻到第 want 题：优先点「下一题」，验证当前格；4 秒没到用答题卡兜底（站点有绕回 bug）
export async function gotoQuestion(page, want) {
  await clickNext(page);
  for (let t = 0; t < 8; t++) {
    await sleep(450);
    if ((await currentCell(page)) === String(want)) return "next";
    if (t === 4) await cardGoto(page, want);
  }
  if ((await currentCell(page)) !== String(want))
    throw new Error(`导航失败：期望第${want}题，实际在第${await currentCell(page)}题`);
  return "card";
}
