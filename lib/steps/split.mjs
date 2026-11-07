// split.mjs — 阶段 3（手写切片版）：prepare.py 拆行 → LLM 挑大题首行 → cut.py 切图 → 总览复核
// 分工与 skill 一致：脚本管像素（边界永远精确落在空白带），模型只做「哪一行是大题开头」的判断。
import path from "node:path";
import { existsSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runProc } from "../jobs.mjs";
import { chatJson, visionMessage } from "../llm.mjs";
import { SKILL_SPLIT, SKILL_CHECK } from "../paths.mjs";

const PY = process.platform === "win32" ? "python" : "python3";
const SPLIT_SCRIPTS = SKILL_SPLIT;
const LOCATE_PY = path.join(SKILL_CHECK, "locate.py");

const PICK_PROMPT = `这是作业手写稿的「行首候选对照表」。表里每格是一行的行首裁片，左上角黄底标签写着它的坐标（形如 p3 L17 y2210）。
逐格判断：行首是不是一个**顶层题号**（一个数字紧跟一个点，如 3. 12. 20.，数字后没有括号）。
判断依据是括号的有无与是否开始一道新题，不是行的长短或位置：
- ✅ 要：1. 2. 10. 14. 20. —— 顶层大题号，后面开始一道新题
- ❌ 不要：(1) (2) （3） ① ② 等小问编号（有括号就不是）
- ❌ 不要：正文续行、算式行、图示行
- ❌ 不要：以「综上所述」「故」「由」「举例」「同理」等开头的承接/小结行
- ❌ 不要：页面顶部印刷的标题、日期
输出 JSON：{"cells":[{"label":"逐字抄下黄底标签","top":true或false,"num":读到的大题号数字（非题号则 null）}]}
cells 按图中顺序（从左到右、从上到下）逐格给出，一格不跳。`;

const OVERVIEW_PROMPT = `这是手写稿切图后的校对总览：上排是每张切片的**开头**几行，下排是**结尾**。切片从 1 开始编号。
逐格检查上排：每一格的开头必须正好是一个顶层题号（数字+点，无括号）。若某格开头是续行、小问编号、结语等，说明这一格切错了。
再看下排与整体：某张切片是否像被下一题截断、或一张图里塞了两道题（该切片中部出现新的顶层题号）。
输出 JSON：{
  "issues":[{"slice":切片号,"kind":"head"|"tail"|"mixed","note":"一句话中文描述"}],
  "mergeCandidates":[切片号,...]
}
mergeCandidates：开头不是顶层题号、应并入上一张切片的编号列表（切片1 不会在里面）；没有就给空数组。`;

export async function runPrepare(ctx, { pdf, workDir }) {
  const { stdout } = await runProc(ctx, PY, [path.join(SPLIT_SCRIPTS, "prepare.py"), pdf, workDir]);
  const sheets = [...stdout.matchAll(/^SHEET (\d+) (.+)$/gm)].map((m) => m[2].trim());
  const done = /^DONE (\d+)页 (\d+)行$/m.exec(stdout);
  if (!sheets.length) throw new Error("prepare.py 没有产出候选对照表");
  ctx.log(`拆行完成：${done?.[1]} 页 ${done?.[2]} 行，${sheets.length} 张候选表`);
  return { sheets, done: done ? { pages: +done[1], lines: +done[2] } : null };
}

// 读行坐标.json 校验 (page, line) 合法性
function validLine(workDir, page, line) {
  try {
    const data = JSON.parse(readFileSync(path.join(workDir, "行坐标.json"), "utf8"));
    const pg = data.pages?.[page - 1];
    return !!pg && line >= 0 && line < (pg.lines?.length || 0);
  } catch {
    return false;
  }
}

// 每张候选表让模型挑大题首行
export async function pickLines(ctx, workDir, sheets) {
  const picked = [];
  for (let i = 0; i < sheets.length; i++) {
    const sheet = sheets[i];
    ctx.log(`读候选表 ${i + 1}/${sheets.length}：${path.basename(sheet)}`);
    const cells = await chatJson([visionMessage(PICK_PROMPT, [sheet])]);
    if (!Array.isArray(cells.cells)) throw new Error("模型输出缺少 cells 数组");
    for (const c of cells.cells) {
      if (!c.top) continue;
      const m = /p\s*(\d+)\s*L\s*(\d+)/i.exec(c.label || "");
      if (!m) {
        ctx.log(`标签读不出坐标：「${c.label}」，跳过该格`, "error");
        continue;
      }
      const page = +m[1], line = +m[2];
      if (!validLine(workDir, page, line)) {
        ctx.log(`坐标越界（p${page} L${line}），丢弃`, "error");
        continue;
      }
      picked.push({ page, line, num: c.num ?? null, label: c.label });
    }
  }
  // 去重 + 按页行排序，顺序编号
  const seen = new Set();
  const uniq = picked.filter((p) => {
    const k = `${p.page}:${p.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  uniq.sort((a, b) => a.page - b.page || a.line - b.line);
  const bounds = uniq.map((p, i) => ({ page: p.page, line: p.line, num: i + 1 }));
  ctx.log(`挑出 ${bounds.length} 个大题首行：${bounds.map((b) => `p${b.page}L${b.line}`).join(" ")}`);
  // 连续性自检：提示性告警
  const nums = uniq.map((p) => p.num).filter((v) => typeof v === "number");
  if (nums.length && (Math.max(...nums) !== bounds.length || new Set(nums).size !== nums.length))
    ctx.log(`注意：模型读到的题号（${nums.join(",")}）与切片数（${bounds.length}）不吻合，总览复核时会再查一遍`, "error");
  return bounds;
}

// 写边界并切图
export async function recut(ctx, { pdf, workDir, bounds, outDir }) {
  const boundsFile = path.join(workDir, "边界.json");
  writeFileSync(boundsFile, JSON.stringify(bounds, null, 1), "utf8");
  const args = [path.join(SPLIT_SCRIPTS, "cut.py"), pdf, workDir, boundsFile, "--out", outDir];
  const { stdout } = await runProc(ctx, PY, args);
  const imgs = [...stdout.matchAll(/^IMG (\S+) (\d+)x(\d+) (.+)$/gm)].map((m) => ({
    num: +m[1], size: `${m[2]}x${m[3]}`, file: m[4].trim(),
  }));
  const overview = /^OVERVIEW (.+)$/m.exec(stdout)?.[1]?.trim();
  const count = +(/^DONE (\d+)$/m.exec(stdout)?.[1] || 0);
  ctx.log(`切出 ${count} 张 → ${outDir}`);
  return { imgs, overview, count, boundsFile };
}

// 总览复核 + 自动并格修复（最多 2 轮）
export async function checkOverview(ctx, overview, bounds) {
  let b = [...bounds];
  const allIssues = [];
  for (let round = 0; round < 2; round++) {
    const res = await chatJson([visionMessage(OVERVIEW_PROMPT, [overview])]);
    const issues = res.issues || [];
    allIssues.push(...issues);
    const merges = (res.mergeCandidates || []).map(Number).filter((n) => n >= 2).sort((a, b) => b - a);
    if (!merges.length) return { bounds: b, issues: allIssues, merged: round > 0 };
    ctx.log(`总览发现 ${merges.length} 处开头不是题号：切片 ${merges.join(",")}，自动并入上一张重切…`, "error");
    for (const s of merges) if (b[s - 1]) b = b.filter((_, i) => i !== s - 1);
    b = b.map((x, i) => ({ ...x, num: i + 1 }));
  }
  return { bounds: b, issues: allIssues, merged: true };
}

// 完整切片流程
export async function runSplit(ctx, { dir, pdf, workDirName = "切图1" }) {
  if (!pdf || !existsSync(pdf)) throw new Error(`手写稿 PDF 不存在：${pdf}`);
  const workDir = path.join(dir, workDirName);
  const outDir = path.join(workDir, "按题分区");
  const { sheets } = await runPrepare(ctx, { pdf, workDir });
  const bounds0 = await pickLines(ctx, workDir, sheets);
  const cut1 = await recut(ctx, { pdf, workDir, bounds: bounds0, outDir });
  if (!cut1.overview) throw new Error("cut.py 没有产出校对总览");
  const check = await checkOverview(ctx, cut1.overview, bounds0);
  let final = { ...cut1 };
  if (check.bounds.length !== bounds0.length) {
    final = await recut(ctx, { pdf, workDir, bounds: check.bounds, outDir });
  }
  return {
    workDir, outDir, overview: final.overview, count: final.count,
    bounds: check.bounds, issues: check.issues, imgs: final.imgs,
  };
}

// 定位某块的行（给红笔步骤用）
export async function locateLines(ctx, block, slices) {
  const { stdout } = await runProc(ctx, PY, [LOCATE_PY, "lines", String(block), "--slices", ...slices]);
  return [...stdout.matchAll(/^L(\d+)\s+y\s+(\d+)\.\.(\d+)\s+h=(\d+)\s+x\s+(\d+)\.\.(\d+)$/gm)].map((m) => ({
    line: +m[1], y0: +m[2], y1: +m[3], h: +m[4], x0: +m[5], x1: +m[6],
  }));
}

// 裁带看内容（返回图片路径）
export async function locateBand(ctx, block, y0, y1, slices, outDir) {
  const { stdout } = await runProc(ctx, PY, [
    LOCATE_PY, "band", String(block), String(y0), String(y1), "x2", "--slices", ...slices, "--out", outDir,
  ]);
  return stdout.trim().split(/\r?\n/).pop();
}

// 列出切片目录里的块（按目录顺序全局编号）
export function enumerateSlices(sliceDirs) {
  const blocks = [];
  for (const d of sliceDirs) {
    const files = readdirSync(d).filter((f) => /^第0*\d+题\.png$/.test(f)).sort(
      (a, b) => parseInt(/^第0*(\d+)题/.exec(a)[1]) - parseInt(/^第0*(\d+)题/.exec(b)[1])
    );
    for (const f of files) blocks.push({ dir: d, file: path.join(d, f) });
  }
  return blocks.map((b, i) => ({ block: i + 1, ...b }));
}
