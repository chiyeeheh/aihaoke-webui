// redpen.mjs — 阶段 5（可选）：手写切片 + 红笔订正
// 模型：找错行、写红字（四要素：错在哪→为什么→正确是什么→结论变不变）；脚本管几何与渲染。
// 定位方式：用 pdf_locate.py annotate 在切片上画蓝色行号标签，模型报行号，y 取该行中点（不凭行号猜内容）。
import path from "node:path";
import { existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runProc } from "../jobs.mjs";
import { chatJson, visionMessage } from "../llm.mjs";
import { SKILL_CHECK } from "../paths.mjs";
import { locateLines, enumerateSlices } from "./split.mjs";

const PY = process.platform === "win32" ? "python" : "python3";
const LOCATE_PY = path.join(SKILL_CHECK, "locate.py");
const REDPEN_PY = path.join(SKILL_CHECK, "redpen.py");
const ANNOTATE_PY = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "py", "pdf_locate.py");

const REVIEW_PROMPT = (n) => `第一张图是手写解答切片（第 ${n} 题），第二张是对应的题面图。
逐行核对手写解答，找出**手稿本身**写错/写漏的地方。注意：识别或转写造成的错误不算手稿的错，不要标。
常见类型（占绝大多数）：丢掉某一项/某个因子/某个指数；只算了一侧（如左极限没算、只讨论 x>0）；展开阶数不够就下结论；
取值范围/端点取错（开闭区间、正负号）；记号冲突（同一字母两种用途）；不等式方向反了；推到一半停住没写结论。

红字要求（这是 HTML 不是 Markdown）：
- 四要素齐全：错在哪 → 为什么 → 正确是什么 → 结果变不变（结论不变也要写明「结论不变」）
- 数学公式用 $...$（MathJax 排版），加粗用 <b>…</b>；不要写 **星号**；不要用列表符号
- 简体中文，一条红字只针对一处错，控制在两三行以内
只输出 JSON：{"errors":[{"quote":"出错那一行的原文（照抄切片里的手写字，便于定位）","note":"红字 HTML"}]}
没有错就输出 {"errors":[]}`;

const ANNOT_PROMPT = `这张手写解答图的每行开头都有一个蓝色编号标签（行号）。需要标红的错误信息如下：
<<<ERR
quote: %QUOTE%
红字: %NOTE%
>>>
找出 quote 描述的那一行——选**最直接体现那个错**的一行（结论写错就指结论行，某一步推错就指那一步）。
只输出 JSON：{"line":行号数字} ；实在找不到对应行则 {"line":null}`;

const SELFCHECK_PROMPT = `这是「手写切片 + 红笔订正」的交付图。逐项检查：
1. 红点/折线是否真的落在出错的那一行（有没有指偏一行）
2. 红字有没有被切断、挤在一起、压住原稿；有没有只剩一个标点或一个字的孤行
3. 红字里的公式有没有渲染成红色报错文字（MathJax 不认识的命令）
只输出 JSON：{"ok":true或false,"fixes":[
  {"kind":"offset","dir":"up"|"down","quote":"哪条红字（引用它的开头几个字）","note":"指偏了，应指上一行/下一行"},
  {"kind":"reword","quote":"哪条红字","note":"改写后的完整红字 HTML（修复截断/孤行）"},
  {"kind":"rewrite","quote":"哪条红字","note":"改写后的完整红字 HTML（换掉渲染不出的命令，如 \\dfrac→\\frac、去掉 \\limits）"}
]}
没问题就输出 {"ok":true,"fixes":[]}`;

async function annotateImg(ctx, img, lines, outBase) {
  const jsonFile = outBase + "_lines.json";
  const outFile = outBase + "_annot.png";
  writeFileSync(jsonFile, JSON.stringify(lines), "utf8");
  await runProc(ctx, PY, [ANNOTATE_PY, "annotate", img, jsonFile, outFile]);
  return outFile;
}

const quoteKey = (q) => String(q || "").replace(/\s+/g, "").slice(0, 24);

// 生成 notes.py（JSON.stringify 的字符串字面量是合法 Python 字符串）
export function writeNotesPy(file, slices, out, notes) {
  const pyNotes = Object.entries(notes)
    .map(([block, items]) => `  ${block}: [\n${items.map((it) => `    (${Math.round(it.y)}, ${JSON.stringify(it.html)}),`).join("\n")}\n  ],`)
    .join("\n");
  const src = `# -*- coding: utf-8 -*-\n# 由 webui 红笔步骤生成；SLICES/OUT 为绝对路径\nSLICES = ${JSON.stringify(slices)}\nOUT = ${JSON.stringify(out)}\nNOTES = {\n${pyNotes}\n}\n`;
  writeFileSync(file, src, "utf8");
}

async function runRedpenPy(ctx, notesFile, blocks = []) {
  const { stdout } = await runProc(ctx, PY, [REDPEN_PY, "--notes", notesFile, ...blocks.map(String)]);
  const outs = [...stdout.matchAll(/^OUT (.+?)\s+(\d+)x(\d+)$/gm)].map((m) => ({ file: m[1].trim(), w: +m[2], h: +m[3] }));
  const dir = /交付目录：(.+?)(（|$)/.exec(stdout)?.[1]?.trim();
  return { outs, dir };
}

export async function runRedpen(ctx, { dir, sliceDirs, proofsDir }) {
  if (!sliceDirs?.length) throw new Error("没有手写切片目录（先做「切片」步骤）");
  for (const d of sliceDirs) if (!existsSync(d)) throw new Error(`切片目录不存在：${d}`);
  const blocks = enumerateSlices(sliceDirs);
  if (!blocks.length) throw new Error("切片目录里没有「第n题.png」");
  const proofImgs = proofsDir && existsSync(proofsDir)
    ? readdirSync(proofsDir).filter((f) => /^第0*\d+题\.png$/.test(f))
        .sort((a, b) => parseInt(/^第0*(\d+)题/.exec(a)[1]) - parseInt(/^第0*(\d+)题/.exec(b)[1]))
        .map((f) => path.join(proofsDir, f))
    : [];

  const workDir = path.join(dir, "_redpen_webui");
  mkdirSync(workDir, { recursive: true });
  const notes = {}; // block -> [{y, html, quote}]
  const linesCache = {}; // block -> lines

  // 1) 逐块找错 + 定位
  for (const b of blocks) {
    ctx.log(`审第 ${b.block} 题（${path.basename(b.file)}）…`);
    const imgs = [b.file, proofImgs[b.block - 1]].filter(Boolean);
    let res;
    try {
      res = await chatJson([visionMessage(REVIEW_PROMPT(b.block), imgs)]);
    } catch (e) {
      ctx.log(`第 ${b.block} 题审查失败：${e.message}`, "error");
      continue;
    }
    const errs = res.errors || [];
    if (!errs.length) {
      ctx.log(`第 ${b.block} 题：无订正`);
      continue;
    }
    const lines = (linesCache[b.block] ||= await locateLines(ctx, b.block, sliceDirs));
    const annot = await annotateImg(ctx, b.file, lines, path.join(workDir, `块${String(b.block).padStart(2, "0")}`));
    for (const err of errs) {
      let lineNo = null;
      try {
        const prompt = ANNOT_PROMPT.replace("%QUOTE%", err.quote || "").replace("%NOTE%", err.note || "");
        lineNo = (await chatJson([visionMessage(prompt, [annot])])).line;
      } catch (e) {
        ctx.log(`第 ${b.block} 题定位失败：${e.message}`, "error");
      }
      if (lineNo == null || !lines[lineNo]) {
        ctx.log(`第 ${b.block} 题有一处订正没定位到行（quote：${(err.quote || "").slice(0, 30)}…），已跳过`, "error");
        continue;
      }
      const ln = lines[lineNo];
      (notes[b.block] ||= []).push({ y: Math.round((ln.y0 + ln.y1) / 2), html: err.note, quote: err.quote || "", lineNo });
      ctx.log(`第 ${b.block} 题 L${lineNo} ← ${String(err.note).replace(/<[^>]+>/g, "").slice(0, 40)}…`);
    }
  }
  if (!Object.keys(notes).length) {
    ctx.log("全部切片都没有需要订正的地方。");
    return { outDir: "", notes: {}, count: 0 };
  }

  // 2) 生成 notes.py 并合成
  const notesFile = path.join(workDir, "notes.py");
  const outDir = path.join(dir, "图片_手写订正");
  writeNotesPy(notesFile, sliceDirs, outDir, notes);
  await runRedpenPy(ctx, notesFile);

  // 3) 逐张自检 + 自动修复（最多 2 轮）
  for (let round = 1; round <= 2; round++) {
    const dirty = Object.keys(notes).map(Number);
    let fixedAny = false;
    for (const blk of dirty) {
      const deliverImg = path.join(outDir, `第${String(blk).padStart(2, "0")}题.png`);
      if (!existsSync(deliverImg)) continue;
      let res;
      try {
        res = await chatJson([visionMessage(SELFCHECK_PROMPT, [deliverImg])]);
      } catch (e) {
        ctx.log(`第 ${blk} 题自检失败：${e.message}`, "error");
        continue;
      }
      if (res.ok) continue;
      const lines = linesCache[blk] || (await locateLines(ctx, blk, sliceDirs));
      const items = notes[blk];
      for (const fix of res.fixes || []) {
        const it = items.find((x) => quoteKey(x.quote).startsWith(quoteKey(fix.quote).slice(0, 12)) || quoteKey(x.html).startsWith(quoteKey(fix.quote).slice(0, 12)));
        if (!it) {
          ctx.log(`第 ${blk} 题的修复没找到对应红字（${fix.quote}）`, "error");
          continue;
        }
        if (fix.kind === "offset") {
          const idx = lines.findIndex((l) => Math.round((l.y0 + l.y1) / 2) === it.y);
          const target = fix.dir === "up" ? idx - 1 : idx + 1;
          if (lines[target]) {
            it.y = Math.round((lines[target].y0 + lines[target].y1) / 2);
            it.lineNo = target;
            fixedAny = true;
            ctx.log(`第 ${blk} 题红点修正：L${idx} → L${target}`);
          }
        } else if (fix.kind === "reword" || fix.kind === "rewrite") {
          if (fix.note && fix.note.length > 4) {
            it.html = fix.note;
            fixedAny = true;
            ctx.log(`第 ${blk} 题红字已改写（${fix.kind}）`);
          }
        }
      }
    }
    if (!fixedAny) break;
    writeNotesPy(notesFile, sliceDirs, outDir, notes);
    await runRedpenPy(ctx, notesFile, dirty);
  }

  const count = Object.keys(notes).length;
  ctx.log(`订正完成：${count} 个块有红笔 → ${outDir}。请在画廊里逐张检查。`);
  return { outDir, notes, count };
}

// 只重跑指定块（UI 改了红字数据后）
export async function rerunBlocks(ctx, { dir, sliceDirs, notes, blocks }) {
  const workDir = path.join(dir, "_redpen_webui");
  mkdirSync(workDir, { recursive: true });
  const notesFile = path.join(workDir, "notes.py");
  const outDir = path.join(dir, "图片_手写订正");
  writeNotesPy(notesFile, sliceDirs, outDir, notes);
  await runRedpenPy(ctx, notesFile, blocks);
  return { outDir };
}
