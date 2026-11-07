// proofread.mjs — 阶段 1b 校对：教材 PDF 定位原题 → 逐题与网页题面比对 → 题面图/ + 对照表.md
// 规则（来自 orchestrator SKILL）：选题以网页为准，细节以原题为准 ——
// 缺题干、错别字、数学符号错误、缺图的一律裁原题替换；仅标点/语序差异保留网页图。
import path from "node:path";
import { existsSync, mkdirSync, writeFileSync, copyFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runProc } from "../jobs.mjs";
import { chatJson, visionMessage } from "../llm.mjs";
import { readStemTexts } from "./simple.mjs";
import { dataDirFor } from "../paths.mjs";

const PY = process.platform === "win32" ? "python" : "python3";
const LOCATE_PY = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "py", "pdf_locate.py");

const COMPARE_PROMPT = `你是数学作业校对员。第一张图是作业平台网页上的题面截图，第二张是教材里的原题裁图。
按以下规则判断该用哪张作为最终题面图：
- 网页题面**缺题干、有错别字、数学符号错误、缺图**的 → 用原题（use_original）
- 仅标点/语序差异 → 保留网页图（use_web）
- 两者内容实质一致 → 用网页图（use_web）
只输出 JSON：{"verdict":"use_web"|"use_original","reason":"一句话中文原因"}`;

const LOCATE_PROMPT = `前面是作业平台网页上的某道题截图，后面几张是教材页。请在这几页教材里找出这道原题。
只输出 JSON：{"page":页码或null,"bbox":[x0,y0,x1,y1]}
- bbox 是题目（含小题与配图）在页面里的位置，四个值都是 0~1 的比例（相对整页宽高），尽量贴紧题目的边界
- 若这些页里都没有这道题，输出 {"page":null}
- 页码以图片下方或你被告知的页码为准`;

async function pdfLocate(ctx, cmd, args) {
  const { stdout } = await runProc(ctx, PY, [LOCATE_PY, cmd, ...args]);
  return JSON.parse(stdout.trim().split(/\r?\n/).pop());
}

// 解析章节字段："习题1" 或 "习题1@120-135"
function parseChapter(chapter) {
  const m = /^(.*?)@(\d+)\s*[-~]\s*(\d+)$/.exec(chapter || "");
  if (m) return { label: m[1], range: [parseInt(m[2]), parseInt(m[3])] };
  return { label: (chapter || "").trim(), range: null };
}

// 章节标签的数字变体：习题1 ↔ 习题一（教材常用水为中文数字）
const CN_NUM = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
function labelVariants(label) {
  const out = new Set([label]);
  const toCn = label.replace(/\d+/g, (d) => (CN_NUM[+d] ?? d));
  out.add(toCn);
  // 中文数字 → 阿拉伯数字（只处理 1-20 的简单情形）
  let toAr = label;
  for (let i = 1; i <= 20; i++) toAr = toAr.split(CN_NUM[i]).join(String(i));
  out.add(toAr);
  return [...out].filter(Boolean);
}

// 确定章节候选页码范围
async function chapterRange(ctx, textbook, chapter) {
  const { label, range } = parseChapter(chapter);
  if (range) {
    ctx.log(`使用指定页码范围：${range[0]}-${range[1]}`);
    return range;
  }
  if (!label) throw new Error("没有指定章节（如「习题1」，或「习题1@120-135」直接给页码范围）");
  const variants = labelVariants(label);
  // 1) 书签定位
  try {
    const toc = await pdfLocate(ctx, "toc", [textbook]);
    const idx = toc.findIndex((t) => t.title && variants.some((v) => t.title.includes(v)));
    if (idx >= 0) {
      const start = toc[idx].page;
      // 章节终点 = 下一个同级或更高级书签（跳过子级【1】【2】…）
      let end = start + 40;
      for (let k = idx + 1; k < toc.length; k++) {
        if ((toc[k].level ?? 1) <= (toc[idx].level ?? 1)) {
          end = toc[k].page - 1;
          break;
        }
      }
      ctx.log(`书签定位「${toc[idx].title}」：第 ${start}-${Math.max(start, end)} 页`);
      return [start, Math.max(start, end)];
    }
    ctx.log(`书签里没找到「${label}」（试过 ${variants.join("/")}），改用文字层搜索…`);
  } catch (e) {
    ctx.log(`书签读取失败（${e.message}），改用文字层搜索…`);
  }
  // 2) 文字层搜标题
  for (const v of variants) {
    const hits = await pdfLocate(ctx, "search", [textbook, v]).catch(() => []);
    if (hits.length) {
      const pages = hits.map((h) => h.page);
      const start = Math.min(...pages);
      const end = Math.min(Math.max(...pages) + 8, start + 60);
      ctx.log(`文字层定位「${v}」：第 ${start}-${end} 页（命中 ${pages.join(",")}）`);
      return [start, end];
    }
  }
  throw new Error(`教材里定位不到「${label}」。请在作业详情里把章节写成「${label}@起页-末页」格式后重试。`);
}

export async function runProofread(ctx, { dir, haokeDir, textbook, chapter, outName }) {
  if (!existsSync(haokeDir)) throw new Error(`没有网页抓题目录：${haokeDir}。请先执行「抓题」。`);
  if (!textbook || !existsSync(textbook)) throw new Error(`教材 PDF 不存在：${textbook}`);
  const stems = readStemTexts(haokeDir);
  const nums = stems.length
    ? stems.map((s) => s.n)
    : readdirSync(haokeDir)
        .map((f) => /^第0*(\d+)题\.png$/.exec(f)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
  if (!nums.length) throw new Error("抓题目录里没有题面图，请先重新抓题。");

  const proofsDir = path.join(dir, outName || `${path.basename(dir)}_题面图`);
  mkdirSync(proofsDir, { recursive: true });
  const workDir = path.join(dataDirFor(dir), "proofread");
  mkdirSync(workDir, { recursive: true });

  // 渲染章节候选页
  const [start, end] = await chapterRange(ctx, textbook, chapter);
  const pagesDir = path.join(workDir, "pages");
  mkdirSync(pagesDir, { recursive: true });
  await runProc(ctx, PY, [LOCATE_PY, "pages", textbook, String(start), String(end), pagesDir, "--dpi", "150"]);
  const pageImg = (p) => path.join(pagesDir, `p${String(p).padStart(3, "0")}.png`);

  const decisions = [];
  for (const n of nums) {
    ctx.log(`—— 第 ${n} 题 ——`);
    const webImg = path.join(haokeDir, `第${String(n).padStart(2, "0")}题.png`);
    if (!existsSync(webImg)) {
      ctx.log(`缺少网页截图 第${String(n).padStart(2, "0")}题.png，跳过`, "error");
      decisions.push({ n, verdict: "missing", reason: "缺网页截图" });
      continue;
    }
    const stemText = stems.find((s) => s.n === n)?.text || "";

    // 1) 找原题所在页：文字层关键词 → 收窄候选页
    let candidatePages = [];
    for (const len of [20, 14, 10]) {
      const key = (stemText || "").replace(/\s+/g, "").slice(0, len);
      if (key.length < 6) break;
      const hits = await pdfLocate(ctx, "search", [textbook, key.slice(0, 8)]).catch(() => []);
      candidatePages = hits.map((h) => h.page).filter((p) => p >= start - 2 && p <= end + 2);
      if (candidatePages.length) break;
    }
    if (!candidatePages.length) {
      // 关键词搜不到：把章节前几页给模型翻
      candidatePages = [];
      for (let p = start; p <= Math.min(end, start + 5); p++) candidatePages.push(p);
      ctx.log(`关键词未命中，让模型在前几页（${candidatePages.join(",")}）里找…`);
    }
    candidatePages = [...new Set(candidatePages)].slice(0, 5);

    // 2) LLM 定位页码与 bbox
    let located = null;
    try {
      const imgs = [webImg, ...candidatePages.filter((p) => existsSync(pageImg(p)))];
      const msg = visionMessage(
        LOCATE_PROMPT + `\n候选页码依次是：${candidatePages.join("、")}。`,
        imgs
      );
      located = await chatJson([msg]);
    } catch (e) {
      ctx.log(`定位失败：${e.message}`, "error");
    }
    if (!located || !located.page || !located.bbox) {
      ctx.log(`第 ${n} 题在教材里没定位到，题面图先用网页版。可在下方改页码后单题重校。`, "error");
      copyFileSync(webImg, path.join(proofsDir, `第${String(n).padStart(2, "0")}题.png`));
      decisions.push({ n, verdict: "web_fallback", reason: "教材定位失败，用网页图" });
      ctx.result({ decisions: [...decisions] });
      continue;
    }

    // 3) 按比例 bbox 裁原题（外扩 1.5% 防贴边）
    const [x0, y0, x1, y1] = located.bbox.map((v) => Math.min(1, Math.max(0, v)));
    const pad = 0.015;
    const rect = [x0 - pad, y0 - pad, x1 + pad, y1 + pad].map((v) => Math.min(1, Math.max(0, v))).join(",");
    const cropImg = path.join(workDir, `原题_${String(n).padStart(2, "0")}.png`);
    try {
      await runProc(ctx, PY, [LOCATE_PY, "render", textbook, String(located.page), cropImg, "--dpi", "200", "--rect", rect]);
    } catch (e) {
      ctx.log(`裁图失败：${e.message}`, "error");
      copyFileSync(webImg, path.join(proofsDir, `第${String(n).padStart(2, "0")}题.png`));
      decisions.push({ n, verdict: "web_fallback", reason: "原题裁图失败" });
      continue;
    }

    // 4) 双图比对
    let verdict = { verdict: "use_web", reason: "默认保留网页图" };
    try {
      verdict = await chatJson([visionMessage(COMPARE_PROMPT, [webImg, cropImg])]);
    } catch (e) {
      ctx.log(`比对失败：${e.message}，保留网页图`, "error");
    }
    const final = verdict.verdict === "use_original" ? cropImg : webImg;
    copyFileSync(final, path.join(proofsDir, `第${String(n).padStart(2, "0")}题.png`));
    decisions.push({
      n,
      verdict: verdict.verdict === "use_original" ? "original" : "web",
      reason: verdict.reason || "",
      page: located.page,
      crop: cropImg,
    });
    ctx.log(`第 ${n} 题：${verdict.verdict === "use_original" ? "采用原题裁图" : "保留网页图"}（教材第 ${located.page} 页）—— ${verdict.reason}`);
    ctx.result({ decisions: [...decisions] });
  }

  // 5) 对照表.md
  const lines = [
    `# ${path.basename(dir)} 题面对照表`,
    "",
    `| 题号 | 采用 | 原因 | 教材页 |`,
    `|---|---|---|---|`,
    ...decisions.map((d) =>
      `| ${d.n} | ${d.verdict === "original" ? "原题裁图" : d.verdict === "missing" ? "缺图" : "网页图"} | ${d.reason} | ${d.page ?? "-"} |`
    ),
    "",
    `规则：选题以网页为准，细节以原题为准——缺题干、错别字、数学符号错误、缺图的一律裁原题替换；仅标点/语序差异保留网页图。`,
  ];
  writeFileSync(path.join(proofsDir, "对照表.md"), lines.join("\n"), "utf8");
  const replaced = decisions.filter((d) => d.verdict === "original").length;
  ctx.log(`校对完成：${nums.length} 题，其中 ${replaced} 题替换为原题裁图 → ${proofsDir}`);
  return { proofsDir, decisions };
}
