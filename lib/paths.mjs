// paths.mjs — 设置读写、路径白名单、作业目录扫描与产物探测
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // webui/
export const DATA_DIR = path.join(ROOT, "data");
export const CONFIG_FILE = path.join(ROOT, "config.json");

// 上游脚本位置：优先用相邻的 skill 原版（本地随 skill 安装时，脚本更新即时生效、
// Chrome 登录档案沿用原位置）；独立克隆本仓库时回退到 vendor/ 里的随附副本（首次运行自动装依赖）。
// 用标志性文件判断目录确实可用，防止克隆位置巧合撞名。
function pickScripts(vendorName, siblingScripts, marker) {
  if (existsSync(path.join(siblingScripts, marker))) return siblingScripts;
  return path.join(ROOT, "vendor", vendorName, "scripts");
}

// 本地随 skill 安装时：ROOT=…/skills/sjtu-aihaoke-automation/webui，
// orchestrator 脚本在 …/skills/sjtu-aihaoke-automation/scripts，兄弟 skill 在 …/skills/sjtu-hw-*/scripts
const SKILLS_DIR = path.dirname(path.dirname(ROOT));
export const SKILL_MAIN = pickScripts("haoke", path.join(SKILLS_DIR, "sjtu-aihaoke-automation", "scripts"), "capture.mjs"); // capture/upload/hw_clean（新版：复用 Chrome、不关浏览器）
export const SKILL_SPLIT = pickScripts("split", path.join(SKILLS_DIR, "sjtu-hw-split", "scripts"), "prepare.py");
export const SKILL_LATEX = pickScripts("latex", path.join(SKILLS_DIR, "sjtu-hw-to-latex", "scripts"), "hw_pdf.py");
export const SKILL_CHECK = pickScripts("check", path.join(SKILLS_DIR, "sjtu-hw-check", "scripts"), "redpen.py");

export const DEFAULT_CONFIG = {
  llm: {
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    apiKey: "",
    visionModel: "", // 视觉模型：校对/挑行/转写/红笔用
    textModel: "",   // 文本模型：汇总/对照表措辞等用；留空则用视觉模型
    temperature: 0.2,
  },
  assignmentsRoot: "", // 作业根目录（设置页填写，扫描「课程/第N次作业」两层结构）
  defaultTextbook: "", // 默认教材 PDF
  port: 8420,
};

export function loadConfig() {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    return deepMerge(structuredClone(DEFAULT_CONFIG), raw);
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function saveConfig(patch) {
  const merged = deepMerge(loadConfig(), patch);
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

function deepMerge(base, patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object")
      base[k] = deepMerge(base[k], v);
    else if (v !== undefined) base[k] = v;
  }
  return base;
}

// ---------- 路径白名单 ----------

// 尽量取真实路径（化解符号链接/联接别名，如 ~/.zcode/skills → ~/.claude/skills）
function real(p) {
  try {
    return realpathSync(p).toLowerCase();
  } catch {
    return path.resolve(p).toLowerCase();
  }
}

export function allowedRoots(config) {
  const roots = [ROOT, DATA_DIR, SKILL_MAIN, SKILL_SPLIT, SKILL_LATEX, SKILL_CHECK];
  if (config.assignmentsRoot) roots.push(path.resolve(config.assignmentsRoot));
  return roots.map(real);
}

// 校验路径必须在白名单根下（防目录穿越）；返回规范化绝对路径或 null
export function resolveSafe(config, p) {
  if (!p) return null;
  const abs = path.resolve(String(p));
  const low = real(abs);
  const roots = allowedRoots(config);
  const ok = roots.some((r) => low === r || low.startsWith(r + path.sep));
  return ok ? abs : null;
}

// 每份作业在 data/ 下的状态目录（按路径哈希，避免中文路径做目录名）
export function dataDirFor(assignmentPath) {
  const h = crypto.createHash("sha1").update(path.resolve(assignmentPath).toLowerCase()).digest("hex").slice(0, 12);
  const d = path.join(DATA_DIR, h);
  mkdirSync(d, { recursive: true });
  return d;
}

// ---------- 产物探测 ----------

const probRe = /^第0*(\d+)题\.png$/;

export function countProblems(dir) {
  try {
    return readdirSync(dir)
      .map((f) => {
        const m = probRe.exec(f);
        return m ? parseInt(m[1], 10) : 0;
      })
      .filter(Boolean)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

function dirExists(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// 探测一份作业目录的各阶段产物
export function probeAssignment(dir) {
  const info = {
    path: dir,
    name: path.basename(dir),
    course: path.basename(path.dirname(dir)),
    haokeDir: "",
    captured: [],
    proofread: false,
    proofsDir: "",
    pdfs: [],
    slicesDir: "",   // 按题分区
    sliced: [],
    latexDir: "",    // *_转换
    latexImages: [],
    redpenDir: "",   // 图片_手写订正
    redpenCount: 0,
    textbook: "",
    chapter: "",
  };
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const e of entries) {
    const full = path.join(dir, e);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      if (e.endsWith("_haoke") || e === "_抓题") {
        const nums = countProblems(full);
        if (nums.length && (!info.haokeDir || nums.length > info.captured.length)) {
          info.haokeDir = full;
          info.captured = nums;
        }
      }
      if (e.endsWith("_题面图")) {
        info.proofsDir = full;
        const nums = countProblems(full);
        if (nums.length) info.proofread = true;
      }
      if (e === "按题分区" || (e.endsWith("_按题分区") && !info.slicesDir)) {
        const nums = countProblems(full);
        if (nums.length) {
          info.slicesDir = full;
          info.sliced = nums;
        }
      }
      if (e.endsWith("_转换")) {
        const imgs = path.join(full, "图片");
        const nums = countProblems(imgs);
        if (nums.length) {
          info.latexDir = full;
          info.latexImages = nums;
        }
      }
      if (e === "图片_手写订正" || e.endsWith("_手写订正")) {
        const nums = countProblems(full);
        if (nums.length) {
          info.redpenDir = full;
          info.redpenCount = nums.length;
        }
      }
      if (/切图\d*/.test(e) && !info.slicesDir) {
        const inner = path.join(full, "按题分区");
        const nums = countProblems(inner);
        if (nums.length) {
          info.slicesDir = inner;
          info.sliced = nums;
        }
      }
    } else if (e.toLowerCase().endsWith(".pdf")) {
      // 作业手写稿 = 名字与作业目录同源或带（1）（2）的 PDF；教材一般不在作业目录里
      info.pdfs.push(full);
    }
  }
  // 教材信息从 data 状态里补
  try {
    const st = JSON.parse(readFileSync(path.join(dataDirFor(dir), "state.json"), "utf8"));
    info.textbook = st.textbook || "";
    info.chapter = st.chapter || "";
    info.uploadState = st.upload || null;
  } catch {}
  return info;
}

// 扫描根目录两层，找出像作业的目录
export function scanAssignments(config) {
  const root = config.assignmentsRoot;
  const out = [];
  if (!root || !existsSync(root)) return out;
  for (const course of readdirSync(root)) {
    const courseDir = path.join(root, course);
    let stats;
    try {
      stats = statSync(courseDir);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) continue;
    for (const name of readdirSync(courseDir)) {
      const dir = path.join(courseDir, name);
      let st;
      try {
        st = statSync(dir);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const probe = probeAssignment(dir);
      const likeAssignment =
        /第.+次作业|作业\s*\d+/.test(name) ||
        probe.captured.length || probe.sliced.length || probe.latexImages.length ||
        probe.redpenCount || probe.proofread;
      if (probe && likeAssignment) out.push(probe);
    }
  }
  out.sort((a, b) => a.course.localeCompare(b.course, "zh") || a.name.localeCompare(b.name, "zh"));
  return out;
}

// 每作业状态读写（上传结果、教材/章节记忆等）
export function readState(assignmentPath) {
  try {
    return JSON.parse(readFileSync(path.join(dataDirFor(assignmentPath), "state.json"), "utf8"));
  } catch {
    return {};
  }
}

export function writeState(assignmentPath, patch) {
  const d = dataDirFor(assignmentPath);
  const st = { ...readState(assignmentPath), ...patch };
  writeFileSync(path.join(d, "state.json"), JSON.stringify(st, null, 2), "utf8");
  return st;
}
