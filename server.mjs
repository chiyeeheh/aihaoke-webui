// server.mjs — haoke 作业流水线本机面板
// 只绑定 127.0.0.1；脚本行为完全继承 skill 铁律：绝不关 Chrome、绝不替用户点提交。
import express from "express";
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync, statSync, unlinkSync } from "node:fs";
import {
  loadConfig, saveConfig, resolveSafe, scanAssignments, probeAssignment, readState, writeState,
  ROOT, DATA_DIR, DEFAULT_CONFIG, countProblems,
} from "./lib/paths.mjs";
import { createJob, getJob, subscribe } from "./lib/jobs.mjs";
import { runCapture, runUpload, runClean, readStemTexts } from "./lib/steps/simple.mjs";
import { runProofread } from "./lib/steps/proofread.mjs";
import { runSplit, recut } from "./lib/steps/split.mjs";
import { runLatex, rerender } from "./lib/steps/latex.mjs";
import { runRedpen, rerunBlocks } from "./lib/steps/redpen.mjs";

const app = express();
app.use(express.json({ limit: "60mb" }));

const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".pdf": "application/pdf", ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".tex": "text/plain; charset=utf-8", ".py": "text/plain; charset=utf-8",
};

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    const code = e.code === "BUSY" ? 409 : e.status === 404 ? 404 : 400;
    res.status(code).json({ error: e.message || String(e) });
  }
};

const mustProbe = (req) => {
  const cfg = loadConfig();
  const dir = resolveSafe(cfg, req.query.path || req.body?.path);
  if (!dir || !existsSync(dir)) throw new Error("作业目录不在允许的根目录下，或不存在");
  const probe = probeAssignment(dir);
  if (!probe) throw new Error("读不到作业目录");
  return { cfg, dir, probe };
};

// ---------- 设置 ----------
app.get("/api/settings", (req, res) => {
  const cfg = loadConfig();
  res.json({
    ...cfg,
    llm: { ...cfg.llm, apiKey: cfg.llm.apiKey ? "__SET__" : "" },
    hasKey: !!cfg.llm.apiKey,
  });
});

app.put("/api/settings", wrap((req, res) => {
  const patch = { ...req.body };
  if (patch.llm?.apiKey === "__SET__" || patch.llm?.apiKey === "") delete patch.llm.apiKey; // 不清空已存 Key
  const cfg = saveConfig(patch);
  res.json({ ok: 1, hasKey: !!cfg.llm.apiKey });
}));

// ---------- 作业列表 / 新建 ----------
app.get("/api/assignments", wrap((req, res) => {
  res.json({ assignments: scanAssignments(loadConfig()) });
}));

app.post("/api/assignments", wrap((req, res) => {
  const cfg = loadConfig();
  const { course = "", name, textbook = "", chapter = "" } = req.body || {};
  if (!name || /[\\/:*?"<>|]/.test(name)) throw new Error("作业名不能为空且不能含 \\ / : * ? \" < > |");
  const root = cfg.assignmentsRoot;
  if (!root || !existsSync(root)) throw new Error("作业根目录不存在，请先到设置页填写");
  const dir = course ? path.join(root, course, name) : path.join(root, name);
  if (existsSync(dir)) throw new Error(`目录已存在：${dir}`);
  mkdirSync(dir, { recursive: true });
  if (textbook || chapter) writeState(dir, { textbook, chapter });
  res.json({ ok: 1, path: dir, probe: probeAssignment(dir) });
}));

// ---------- 作业详情 ----------
app.get("/api/assignment/detail", wrap((req, res) => {
  const { cfg, dir, probe } = mustProbe(req);
  const state = readState(dir);
  const list = (d) => (d && existsSync(d) ? countProblems(d) : []);
  const readText = (f, max = 200_000) => {
    try {
      if (!f || !existsSync(f)) return null;
      return readFileSync(f, "utf8").slice(0, max);
    } catch {
      return null;
    }
  };
  const detail = {
    ...probe,
    state,
    textbookExists: probe.textbook ? existsSync(probe.textbook) : false,
    stems: readStemTexts(probe.haokeDir),
    counts: {
      haoke: list(probe.haokeDir).length,
      proofs: list(probe.proofsDir).length,
      slices: list(probe.slicesDir).length,
      latex: list(probe.latexDir && path.join(probe.latexDir, "图片")).length,
      redpen: list(probe.redpenDir).length,
    },
    texts: {
      duizhao: readText(path.join(dir, "对照表.md")) ||
        readText(probe.proofsDir && path.join(probe.proofsDir, "对照表.md")),
      baogao: readText(probe.latexDir && path.join(probe.latexDir, "报告.md")),
      latexTxt: readText(probe.latexDir && path.join(probe.latexDir, "latex", "作业.txt")),
      bounds: readText(state.lastSplit?.boundsFile),
      notes: state.redpenNotes ? JSON.stringify(state.redpenNotes, null, 1) : null,
    },
    sliceDirs: state.sliceDirs || (probe.slicesDir ? [probe.slicesDir] : []),
    sliceDirCounts: Object.fromEntries(
      (state.sliceDirs || (probe.slicesDir ? [probe.slicesDir] : [])).map((s) => [s, countProblems(s).length])
    ),
  };
  res.json(detail);
}));

// ---------- 步骤：抓题 ----------
app.post("/api/steps/capture", wrap((req, res) => {
  const { cfg, dir, probe } = mustProbe(req);
  const job = createJob(dir, "capture", `抓题：${probe.name}`, async (ctx) => {
    const r = await runCapture(ctx, { dir, outName: `${probe.name}_haoke` });
    return r;
  });
  res.json({ jobId: job.id });
}));

// ---------- 步骤：校对 ----------
app.post("/api/steps/proofread", wrap((req, res) => {
  const { cfg, dir, probe } = mustProbe(req);
  const state = readState(dir);
  const textbook = req.body?.textbook || state.textbook || cfg.defaultTextbook;
  const chapter = req.body?.chapter ?? state.chapter ?? "";
  if (req.body?.textbook || req.body?.chapter !== undefined)
    writeState(dir, { textbook: req.body?.textbook || state.textbook, chapter: req.body?.chapter ?? state.chapter });
  if (!probe.haokeDir) throw new Error("还没有网页抓题产物，请先执行「抓题」");
  const job = createJob(dir, "proofread", `校对：${probe.name}`, async (ctx) =>
    runProofread(ctx, { dir, haokeDir: probe.haokeDir, textbook, chapter, outName: `${probe.name}_题面图` })
  );
  res.json({ jobId: job.id });
}));

// ---------- 步骤：切片 / 重新切图 ----------
app.post("/api/steps/split", wrap((req, res) => {
  const { dir, probe } = mustProbe(req);
  const pdfs = (Array.isArray(req.body?.pdfs) && req.body.pdfs.length ? req.body.pdfs : probe.pdfs).filter((p) => existsSync(p));
  if (!pdfs.length) throw new Error("作业目录里没有手写稿 PDF——请先把 PDF 放进作业目录（或用「上传手写稿」按钮）");
  const workDirs = [], sliceDirs = [], overviews = [], allIssues = [];
  const job = createJob(dir, "split", `切片：${probe.name}`, async (ctx) => {
    for (let i = 0; i < pdfs.length; i++) {
      if (pdfs.length > 1) ctx.log(`===== 手写稿 ${i + 1}/${pdfs.length}：${path.basename(pdfs[i])} =====`);
      const r = await runSplit(ctx, { dir, pdf: pdfs[i], workDirName: `切图${i + 1}` });
      workDirs.push(r.workDir);
      sliceDirs.push(r.outDir);
      overviews.push(r.overview);
      allIssues.push(...r.issues);
      writeState(dir, { lastSplit: { pdf: pdfs[i], workDir: r.workDir, boundsFile: path.join(r.workDir, "边界.json"), bounds: r.bounds } });
    }
    writeState(dir, { sliceDirs, overviews });
    if (allIssues.length) ctx.log(`注意：总览复核有 ${allIssues.length} 条未自动修复的疑点，可在「切片」面板查看并手动改边界重切。`, "error");
    return { sliceDirs, overviews, issues: allIssues, count: sliceDirs.reduce((a, d) => a + countProblems(d).length, 0) };
  });
  res.json({ jobId: job.id });
}));

app.post("/api/steps/split-recut", wrap((req, res) => {
  const { dir, probe } = mustProbe(req);
  const state = readState(dir);
  const last = state.lastSplit;
  if (!last) throw new Error("还没有跑过切片步骤");
  const bounds = req.body?.bounds;
  if (!Array.isArray(bounds) || !bounds.length) throw new Error("边界数据为空");
  const job = createJob(dir, "split", `重切：${probe.name}`, async (ctx) => {
    const outDir = path.join(last.workDir, "按题分区");
    const r = await recut(ctx, { pdf: last.pdf, workDir: last.workDir, bounds, outDir });
    writeState(dir, { lastSplit: { ...last, bounds }, overviews: [r.overview] });
    return { count: r.count, overview: r.overview, bounds };
  });
  res.json({ jobId: job.id });
}));

// ---------- 步骤：LaTeX 转写 ----------
app.post("/api/steps/latex", wrap((req, res) => {
  const { dir, probe } = mustProbe(req);
  const state = readState(dir);
  const pdf = req.body?.pdf || probe.pdfs[0];
  const proofsDir = probe.proofsDir || req.body?.proofsDir;
  if (!pdf || !existsSync(pdf)) throw new Error("找不到手写稿 PDF");
  const job = createJob(dir, "latex", `LaTeX 转写：${probe.name}`, async (ctx) => {
    const r = await runLatex(ctx, { dir, pdf, proofsDir });
    writeState(dir, { latexDir: r.work });
    return { imgDir: r.imgDir, done: r.done, changes: r.changes, unsure: r.unsure, spotIssues: r.spotIssues };
  });
  res.json({ jobId: job.id });
}));

app.post("/api/steps/latex-rerender", wrap((req, res) => {
  const { dir, probe } = mustProbe(req);
  const state = readState(dir);
  const txtFile = req.body?.txtFile || (probe.latexDir && path.join(probe.latexDir, "latex", "作业.txt"));
  const imgDir = probe.latexDir && path.join(probe.latexDir, "图片");
  if (!txtFile || !existsSync(txtFile)) throw new Error("找不到 latex/作业.txt");
  const job = createJob(dir, "latex", `重渲染：${probe.name}`, async (ctx) => {
    const r = await rerender(ctx, { txtFile, imgDir });
    return { done: r.done };
  });
  res.json({ jobId: job.id });
}));

// ---------- 上传用的合并暂存目录（多份切片目录 → 顺序重命名到一处） ----------
function stageSlices(cfg, sliceDirs) {
  const stage = path.join(DATA_DIR, "_upload_stage");
  mkdirSync(stage, { recursive: true });
  for (const f of readdirSync(stage)) {
    try {
      if (statSync(path.join(stage, f)).isFile()) unlinkSync(path.join(stage, f));
    } catch {}
  }
  let n = 0;
  for (const d of sliceDirs) {
    for (const f of readdirSync(d).filter((f) => /^第0*\d+题\.png$/.test(f))
      .sort((a, b) => parseInt(/^第0*(\d+)题/.exec(a)[1]) - parseInt(/^第0*(\d+)题/.exec(b)[1]))) {
      n += 1;
      copyFileSync(path.join(d, f), path.join(stage, `第${n}题.png`));
    }
  }
  if (!n) throw new Error("切片目录里没有「第n题.png」");
  return { stage, count: n };
}

// ---------- 步骤：上传 ----------
app.post("/api/steps/upload", wrap((req, res) => {
  const { cfg, dir, probe } = mustProbe(req);
  const state = readState(dir);
  const sliceDirs = req.body?.sliceDirs || state.sliceDirs || (probe.slicesDir ? [probe.slicesDir] : []);
  if (!sliceDirs.length) throw new Error("没有切片目录——先完成「手写稿处理」");
  const force = !!req.body?.force;
  const job = createJob(dir, "upload", `上传：${probe.name}`, async (ctx) => {
    const { stage, count } = stageSlices(cfg, sliceDirs);
    ctx.log(`共 ${count} 张切片，从第 1 题开始逐题上传（绝不点「提交」）…`);
    return runUpload(ctx, { dir, sliceDir: stage, force });
  });
  res.json({ jobId: job.id });
}));

// ---------- 步骤：红笔订正 ----------
app.post("/api/steps/redpen", wrap((req, res) => {
  const { dir, probe } = mustProbe(req);
  const state = readState(dir);
  const sliceDirs = req.body?.sliceDirs || state.sliceDirs || (probe.slicesDir ? [probe.slicesDir] : []);
  const proofsDir = probe.proofsDir;
  if (!sliceDirs.length) throw new Error("没有切片目录——先完成「手写稿处理（切片版）」");
  const job = createJob(dir, "redpen", `红笔订正：${probe.name}`, async (ctx) => {
    const r = await runRedpen(ctx, { dir, sliceDirs, proofsDir });
    writeState(dir, { redpenNotes: r.notes, sliceDirs });
    return { outDir: r.outDir, count: r.count };
  });
  res.json({ jobId: job.id });
}));

app.post("/api/steps/redpen-rerun", wrap((req, res) => {
  const { dir, probe } = mustProbe(req);
  const state = readState(dir);
  const sliceDirs = state.sliceDirs || (probe.slicesDir ? [probe.slicesDir] : []);
  const notes = req.body?.notes || state.redpenNotes;
  if (!notes || !Object.keys(notes).length) throw new Error("没有红笔订正数据");
  const blocks = (req.body?.blocks || Object.keys(notes).map(Number)).map(Number);
  const job = createJob(dir, "redpen", `重出红笔图：${probe.name}`, async (ctx) => {
    writeState(dir, { redpenNotes: notes });
    return rerunBlocks(ctx, { dir, sliceDirs, notes, blocks });
  });
  res.json({ jobId: job.id });
}));

// ---------- 步骤：清理 ----------
app.post("/api/steps/clean", wrap((req, res) => {
  const { dir, probe } = mustProbe(req);
  const dry = req.body?.dry !== false;
  const job = createJob(dir, "clean", `清理${dry ? "（预览）" : ""}：${probe.name}`, async (ctx) =>
    runClean(ctx, { dir, dry })
  );
  res.json({ jobId: job.id });
}));

// ---------- 手写稿 PDF 上传（存进作业目录） ----------
app.post("/api/upload/pdf", wrap((req, res) => {
  const { cfg, dir } = mustProbe(req);
  const name = (req.query.name || "").trim();
  if (!/^[\w\u4e00-\u9fa5（）()\-\s]+\.pdf$/i.test(name)) throw new Error("文件名不合法（只允许中英文、数字、括号、空格）");
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const buf = Buffer.concat(chunks);
    if (!buf.length || buf.length > 300 * 1024 * 1024) {
      res.status(400).json({ error: "文件为空或超过 300MB" });
      return;
    }
    if (buf.slice(0, 5).toString("latin1") !== "%PDF-") {
      res.status(400).json({ error: "不是 PDF 文件" });
      return;
    }
    const file = path.join(dir, name);
    writeFileSync(file, buf);
    res.json({ ok: 1, file, size: buf.length });
  });
}));

// ---------- 文本编辑保存（边界.json / 作业.txt / 对照表 等） ----------
const EDITABLE_EXT = [".json", ".txt", ".md", ".tex", ".py"];
app.put("/api/text", wrap((req, res) => {
  const cfg = loadConfig();
  const p = resolveSafe(cfg, req.body?.path);
  if (!p) throw new Error("路径不在允许范围内");
  if (!EDITABLE_EXT.includes(path.extname(p).toLowerCase())) throw new Error("不允许编辑这种文件类型");
  writeFileSync(p, String(req.body?.content ?? ""), "utf8");
  res.json({ ok: 1 });
}));

// ---------- 作业 ----------
app.get("/api/jobs/:id", (req, res) => {
  const j = getJob(req.params.id);
  if (!j) return res.status(404).json({ error: "no such job" });
  const { subs, fn, ...rest } = j;
  res.json(rest);
});

app.get("/api/jobs/:id/stream", (req, res) => subscribe(res, req.params.id));

// ---------- 文件服务（白名单内） ----------
app.get("/api/file", wrap((req, res) => {
  const cfg = loadConfig();
  const p = resolveSafe(cfg, req.query.path);
  if (!p || !existsSync(p) || !statSync(p).isFile()) throw new Error("文件不存在或不在允许范围内");
  res.type(MIME[path.extname(p).toLowerCase()] || "application/octet-stream");
  res.sendFile(p);
}));

// ---------- 前端 ----------
app.use(express.static(path.join(ROOT, "public")));

const cfg = loadConfig();
const PORT = process.env.PORT || cfg.port || 8420;
app.listen(PORT, "127.0.0.1", () => {
  console.log(`haoke 面板已启动：http://127.0.0.1:${PORT}`);
  console.log("只监听本机回环地址。浏览器与 Chrome 登录态请保持——面板绝不关闭 Chrome。");
});
