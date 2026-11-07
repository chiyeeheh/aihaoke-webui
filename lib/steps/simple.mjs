// simple.mjs — 确定性步骤：抓题 / 上传 / 清理（包装 orchestrator 的现成脚本，不改动它们）
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { SKILL_MAIN } from "../paths.mjs";
import { runProc } from "../jobs.mjs";
import { countProblems, writeState } from "../paths.mjs";

const PY = process.platform === "win32" ? "python" : "python3";

// ---------- 阶段 1a：抓题 ----------
export async function runCapture(ctx, { dir, outName }) {
  const outDir = path.join(dir, outName || `${path.basename(dir)}_haoke`);
  await runProc(ctx, "node", [path.join(SKILL_MAIN, "capture.mjs"), "--out", outDir]);
  const nums = countProblems(outDir);
  ctx.log(`抓到 ${nums.length} 题：${nums.join(", ")}`);
  return { outDir, count: nums.length, nums };
}

// ---------- 阶段 4：上传 ----------
// sliceDir: 装着「第n题.png」的目录
export async function runUpload(ctx, { dir, sliceDir, force = false }) {
  if (!existsSync(sliceDir)) throw new Error(`切片目录不存在：${sliceDir}`);
  const args = [path.join(SKILL_MAIN, "upload.mjs"), "--dir", sliceDir];
  if (force) args.push("--force");
  const { stdout } = await runProc(ctx, "node", args);
  const done = /DONE (.+)$/m.exec(stdout)?.[1] || "";
  const per = done ? done.split(/\s+/).filter(Boolean) : [];
  const failed = per.filter((s) => s.endsWith(":FAIL"));
  const state = writeState(dir, {
    upload: { at: new Date().toISOString(), sliceDir, results: per },
  });
  if (failed.length) throw new Error(`有 ${failed.length} 题上传失败（${failed.join(" ")}）—— 重跑本步骤即可续传（幂等）`);
  ctx.log("上传完成。请在浏览器里逐题检查后【自行点提交】——面板与脚本都不会替你提交。");
  ctx.log("浏览器保持打开，请不要关闭窗口（登录态要留给下次）。");
  return { results: per, uploadState: state.upload };
}

// ---------- 阶段 6：清理 ----------
export async function runClean(ctx, { dir, dry = true }) {
  const args = [path.join(SKILL_MAIN, "hw_clean.py"), dir];
  if (dry) args.push("--dry-run");
  const { stdout } = await runProc(ctx, PY, args);
  const items = stdout
    .split(/\r?\n/)
    .filter((l) => l.startsWith("将删除:") || l.startsWith("已删除:"))
    .map((l) => l.replace(/^(将删除|已删除):\s*/, ""));
  return { items, dry };
}

// ---------- 工具：读题面文本 ----------
export function readStemTexts(haokeDir) {
  try {
    return JSON.parse(readFileSync(path.join(haokeDir, "题面文本.json"), "utf8"));
  } catch {
    return [];
  }
}
