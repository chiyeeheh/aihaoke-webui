// latex.mjs — 阶段 3（LaTeX 重排版）：hw_pdf 拆页 → LLM 逐页转写 → 对照题面订正 → hw_render 出图
// 硬性要求（来自 orchestrator SKILL）：上传的必须是正确的解答 —— 转写后逐题对照题面验算，
// 手稿写错处直接按正确解法重写渲染；所有改动记入报告，不把「不确定」反复抛回给用户。
import path from "node:path";
import { existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { runProc } from "../jobs.mjs";
import { chatJson, textModel, visionMessage } from "../llm.mjs";
import { SKILL_LATEX } from "../paths.mjs";

const PY = process.platform === "win32" ? "python" : "python3";
const LATEX_SCRIPTS = SKILL_LATEX;

const FORMAT_RULES = `格式约定（渲染脚本依赖，必须遵守）：
- 每道大题开头单独占一行：\\noindent\\textbf{3.}（切题就靠它）
- 小题号写在正文里：(1) (2) 这种
- 行内公式 $...$；独立公式 \\[ ... \\]；矩阵 \\begin{bmatrix}...\\end{bmatrix}；方程组 \\begin{cases}...\\end{cases}
- 行变换箭头 \\xrightarrow{r_2-2r_1}；枚举可用 \\begin{enumerate}/\\begin{itemize}
禁止：
- 不要标题区（\\begin{center}、\\maketitle 等）；不要 \\newcommand 自定义命令
- 公式里不要放中文（中文一律写在公式外面）
- 不要用 align/gather 环境（拆成多个 \\[...\\]）`;

const MARKER_RE = /\\noindent\s*\\textbf\s*\{\s*(\d+)\s*(?:\.|。)?\s*\}/g;

export function parseProblems(txt) {
  const out = [];
  const matches = [...txt.matchAll(MARKER_RE)];
  matches.forEach((m, i) => {
    const start = m.index;
    const end = i + 1 < matches.length ? matches[i + 1].index : txt.length;
    out.push({ num: out.length + 1, label: +m[1], body: txt.slice(start, end) });
  });
  return out;
}

const transcribePrompt = (pageNo, total, tail) => `这是手写作业第 ${pageNo} 页（共 ${total} 页）。把整页手写内容转写成 LaTeX。

${FORMAT_RULES}

转写原则：
- 忠实：这一阶段只做「抄写」，不改对错、不补步骤、不润色（订正是后面的事）
- 手写笔迹按最合理的数学读法还原：潦草的分数写成 \\frac{}{}，上下标、希腊字母、向量、行列式都还原规范，但只还原写法、不改内容
- 页眉页脚丢弃：页码、日期、「第X页」这类全不要
- 承接上一页的内容要归位：本页开头延续上一页的内容，直接接着写，不要另起

已转写内容的最后部分（用于衔接与去重；与它重复的段落不要重复输出）：
<<<TAIL
${tail || "（这是第一页）"}
>>>

只输出 JSON：{"latex":"这一页的 LaTeX（去重后真正新增的部分）"}
若整页是空白页或只有页眉页脚，输出 {"latex":""}`;

const correctPrompt = (num, body) => `第一张图是第 ${num} 题的题面，下面的文本是该题的手写解答（已转写为 LaTeX）。
请真算一遍/验一遍，判断解答的对错——不是「像不像」，是真的算。

**最小改动原则（硬性）**：
- 手稿写对的内容**逐字照抄**——步骤、记号、详略、行文顺序都保持原样
- 不补原稿没有的步骤；不把题面写进答案图；不加验证段、理由、反例、另解
- 只改确认错/漏的地方，改动紧贴原稿写法，**能改一行字就不重写一段**
- 正确 ≠ 完整，不要替用户「补全」
- 讨论题漏情况、方程组没写结论这类**确认的漏**要补上；但只是写法简略的不算漏

其他要求：
- 按用户原有解答的思路改，不要另起炉灶换解法（改完会渲染成图片上传）
- 每处改动在改正后的 LaTeX 里留一行注释：% 【改正】原稿……；应为……
- 字迹看不清处按最合理的数学读法还原后验算，并记入 unsure

解答 LaTeX：
<<<LATEX
${body}
>>>

只输出 JSON：{"latex":"订正后的该题完整 LaTeX（保留 % 【改正】注释）","changes":["每处改动一句话"],"unsure":["自己不确定的点，没有则空数组"]}`;

const spotcheckPrompt = `这是用 LaTeX 排版渲染出的数学解答图片。检查排版质量：
- 公式是否渲染成了红色报错文字（MathJax 不认识的命令）
- 矩阵、方程组、多层分数是否显示正常，有没有明显截断
只输出 JSON：{"ok":true或false,"issues":["问题一句话",...]}`;

async function runHwPdf(ctx, pdf, pagesDir) {
  const { stdout } = await runProc(ctx, PY, [path.join(LATEX_SCRIPTS, "hw_pdf.py"), pdf, pagesDir]);
  const pages = [...stdout.matchAll(/^PAGE (\d+) (\d+)x(\d+) (.+)$/gm)].map((m) => ({
    page: +m[1], file: m[4].trim(),
  }));
  if (!pages.length) throw new Error("hw_pdf.py 没有产出页面图");
  return pages;
}

export async function runRender(ctx, txtFile, imgDir) {
  mkdirSync(imgDir, { recursive: true });
  const { stdout } = await runProc(ctx, PY, [path.join(LATEX_SCRIPTS, "hw_render.py"), txtFile, imgDir]);
  const probs = [...stdout.matchAll(/^PROB (\d+) (\S+) (.+)$/gm)].map((m) => ({
    idx: +m[1], label: m[2], file: m[3].trim(),
  }));
  const warns = [...stdout.matchAll(/^WARN (.+)$/gm)].map((m) => m[1].trim());
  const done = +(/^DONE (\d+)$/m.exec(stdout)?.[1] || 0);
  if (!done) throw new Error("渲染出了 0 张图——多半是 作业.txt 里缺 \\noindent\\textbf{} 标记");
  for (const w of warns) ctx.log(`渲染提示：${w}`);
  return { probs, warns, done };
}

function listPngs(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => /^第0*\d+题\.png$/.test(f))
      .sort((a, b) => parseInt(/^第0*(\d+)题/.exec(a)[1]) - parseInt(/^第0*(\d+)题/.exec(b)[1]))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

// 逐页转写（带尾部衔接与去重）
async function transcribe(ctx, pages) {
  const chunks = [];
  let tail = "";
  for (let i = 0; i < pages.length; i++) {
    ctx.log(`转写第 ${i + 1}/${pages.length} 页…`);
    const res = await chatJson([visionMessage(transcribePrompt(i + 1, pages.length, tail), [pages[i].file])]);
    const latex = (res.latex || "").trim();
    chunks.push(latex);
    tail = (tail + "\n" + latex).split("\n").filter(Boolean).slice(-30).join("\n");
    ctx.result({ page: i + 1, latex });
  }
  return chunks.join("\n\n");
}

// 补齐缺失的大题标记（模型漏写时用文本模型兜底）
async function ensureMarkers(ctx, txt, expectedCount) {
  const found = [...txt.matchAll(MARKER_RE)].length;
  if (found > 0 && (!expectedCount || found >= expectedCount)) return txt;
  ctx.log(`大题标记只有 ${found} 个（期望约 ${expectedCount || "?"} 个），让文本模型补齐…`, "error");
  const prompt = `下面这份 LaTeX 缺少「每道大题开头单独占一行 \\noindent\\textbf{N.}」的标记。
请在正确的大题分界处补上标记（题号按出现顺序 1,2,3…），其他内容一字不动。
${expectedCount ? `这份作业共 ${expectedCount} 道大题。` : ""}
<<<TXT
${txt}
>>>
只输出 JSON：{"latex":"补齐标记后的完整 LaTeX"}`;
  const res = await chatJson([{ role: "user", content: prompt }], { model: textModel() });
  return res.latex || txt;
}

// 逐题订正
async function correctAll(ctx, txt, proofsDir, changes, unsure) {
  const probs = parseProblems(txt);
  const proofImgs = listPngs(proofsDir);
  const out = [];
  for (let i = 0; i < probs.length; i++) {
    const p = probs[i];
    const img = proofImgs[i]; // 切片与题面图按顺序一一对应（阶段 1 已对齐题号）
    let body = p.body;
    if (img) {
      ctx.log(`验算订正第 ${p.num} 题…`);
      try {
        const res = await chatJson([visionMessage(correctPrompt(p.label || p.num, p.body), [img])]);
        if (res.latex && res.latex.trim()) body = res.latex.trim();
        for (const c of res.changes || []) {
          changes.push(`第 ${p.num} 题：${c}`);
          ctx.log(`【改正】第 ${p.num} 题：${c}`);
        }
        for (const u of res.unsure || []) unsure.push(`第 ${p.num} 题：${u}`);
      } catch (e) {
        ctx.log(`第 ${p.num} 题订正失败（${e.message}），保留原文`, "error");
      }
    }
    out.push(body);
  }
  return out.join("\n\n");
}

function wrapTex(txt) {
  return [
    "\\documentclass[12pt]{ctexart}",
    "\\usepackage{amsmath,amssymb}",
    "\\usepackage[margin=2.5cm]{geometry}",
    "\\begin{document}",
    txt,
    "\\end{document}",
  ].join("\n");
}

export async function runLatex(ctx, { dir, pdf, proofsDir }) {
  if (!pdf || !existsSync(pdf)) throw new Error(`手写稿 PDF 不存在：${pdf}`);
  const name = path.basename(dir);
  const work = path.join(dir, `${name}_转换`);
  const pagesDir = path.join(work, "页面");
  const latexDir = path.join(work, "latex");
  const imgDir = path.join(work, "图片");
  mkdirSync(pagesDir, { recursive: true });
  mkdirSync(latexDir, { recursive: true });

  // 1) 拆页
  const pages = await runHwPdf(ctx, pdf, pagesDir);
  ctx.log(`拆出 ${pages.length} 页（空白页已跳过）`);

  // 2) 逐页转写
  let txt = await transcribe(ctx, pages);

  // 3) 订正（有题面图才做）
  const changes = [], unsure = [];
  const hasProofs = proofsDir && existsSync(proofsDir);
  txt = await ensureMarkers(ctx, txt, hasProofs ? listPngs(proofsDir).length : 0);
  if (hasProofs) {
    txt = await correctAll(ctx, txt, proofsDir, changes, unsure);
  } else {
    ctx.log("没有题面图，跳过对照订正（报告会注明「未对照题目核对」）", "error");
  }

  // 4) 落盘
  writeFileSync(path.join(latexDir, "作业.txt"), txt, "utf8");
  writeFileSync(path.join(latexDir, "作业.tex"), wrapTex(txt), "utf8");

  // 5) 渲染
  const render = await runRender(ctx, path.join(latexDir, "作业.txt"), imgDir);

  // 6) 渲染抽查（优先挑含矩阵/方程组的题）
  const bodies = parseProblems(txt);
  const rich = render.probs.filter((p) => /bmatrix|pmatrix|cases/.test(bodies[p.idx - 1]?.body || ""));
  const spot = rich.length ? rich.slice(0, 3) : render.probs.slice(0, 2);
  const spotIssues = [];
  for (const p of spot) {
    if (!existsSync(p.file)) continue;
    try {
      const r = await chatJson([visionMessage(spotcheckPrompt, [p.file])]);
      if (!r.ok) spotIssues.push(...(r.issues || []).map((s) => `第${p.idx}题：${s}`));
    } catch (e) {
      ctx.log(`抽查失败：${e.message}`, "error");
    }
  }
  if (spotIssues.length) ctx.log(`渲染抽查发现问题：${spotIssues.join("；")}`, "error");

  // 7) 报告
  const report = [
    `# ${name} 转换报告`, "",
    `- 源文件：${pdf}`,
    `- 页数 / 题数：${pages.length} / ${render.done}`,
    `- 产物：latex/作业.txt、latex/作业.tex、图片/第N题.png`,
    hasProofs ? "" : "- ⚠ 未对照题目核对（没有题面图）", "",
    `## 订正记录`, ...(changes.length ? changes.map((c) => `- ${c}`) : ["- 无"]), "",
    `## 待你核对`, ...(unsure.length ? unsure.map((c) => `- ${c}`) : ["- 无"]), "",
    ...(spotIssues.length ? [`## 渲染抽查`, ...spotIssues.map((s) => `- ${s}`)] : []),
  ].filter(Boolean).join("\n");
  writeFileSync(path.join(work, "报告.md"), report, "utf8");
  ctx.log(`完成：${render.done} 张渲染图 → ${imgDir}`);
  return { work, imgDir, txtFile: path.join(latexDir, "作业.txt"), done: render.done, changes, unsure, spotIssues };
}

// 只重渲染（用户在 UI 里改了 作业.txt 之后）
export async function rerender(ctx, { txtFile, imgDir }) {
  return runRender(ctx, txtFile, imgDir);
}
