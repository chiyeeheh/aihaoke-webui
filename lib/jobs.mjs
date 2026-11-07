// jobs.mjs — 后台作业运行器：spawn 子进程、日志环形缓冲、SSE 推送、每作业互斥
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const jobs = new Map(); // id -> job
const locks = new Map(); // "<assignmentHash>:<step>" -> jobId（同作业同步骤互斥）

export function jobLockBusy(assignmentPath, step) {
  const key = lockKey(assignmentPath, step);
  const id = locks.get(key);
  if (!id) return false;
  const j = jobs.get(id);
  return !!j && j.status === "running";
}

const lockKey = (p, step) =>
  crypto.createHash("sha1").update(String(p).toLowerCase()).digest("hex").slice(0, 10) + ":" + step;

export function createJob(assignmentPath, step, title, fn) {
  const key = lockKey(assignmentPath, step);
  if (locks.get(key) && jobs.get(locks.get(key))?.status === "running")
    throw Object.assign(new Error("该作业的这个步骤正在运行中"), { code: "BUSY" });
  const id = crypto.randomUUID();
  const job = {
    id, step, title, assignmentPath,
    status: "running", // running | done | error
    startedAt: Date.now(),
    endedAt: null,
    events: [],        // {t, type:'log'|'status'|'result', text/object}
    result: null,
    error: null,
    subs: new Set(),
    fn,
  };
  jobs.set(id, job);
  locks.set(key, id);
  // 内存上限：只留最近 60 个作业
  if (jobs.size > 60) {
    const oldest = [...jobs.values()].filter((j) => j.status !== "running").sort((a, b) => a.startedAt - b.startedAt)[0];
    if (oldest) jobs.delete(oldest.id);
  }
  if (typeof fn === "function") queueMicrotask(() => runJobFn(job).catch(() => {}));
  return job;
}

async function runJobFn(job) {
  try {
    const result = await job.fn(ctxFor(job));
    job.status = "done";
    job.result = result ?? null;
    push(job, { type: "status", status: "done", result: result ?? null });
  } catch (e) {
    job.status = "error";
    job.error = e.message || String(e);
    push(job, { type: "log", level: "error", text: "✖ " + job.error });
    push(job, { type: "status", status: "error", error: job.error });
  } finally {
    job.endedAt = Date.now();
    const key = lockKey(job.assignmentPath, job.step);
    if (locks.get(key) === job.id) locks.delete(key);
    for (const res of job.subs) res.end();
    job.subs.clear();
  }
}

function ctxFor(job) {
  return {
    log: (text, level = "info") => push(job, { type: "log", level, text: String(text) }),
    result: (object) => push(job, { type: "result", object }),
  };
}

function push(job, ev) {
  ev.t = Date.now();
  job.events.push(ev);
  if (job.events.length > 4000) job.events.splice(0, job.events.length - 4000);
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of job.subs) res.write(line);
}

export function getJob(id) {
  return jobs.get(id) || null;
}

// SSE 订阅：先回放历史，再挂到实时
export function subscribe(res, id) {
  const job = jobs.get(id);
  if (!job) {
    res.status(404).end("no such job");
    return;
  }
  res.set({ "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.flushHeaders?.();
  for (const ev of job.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  if (job.status !== "running") {
    res.end();
    return;
  }
  job.subs.add(res);
  res.on("close", () => job.subs.delete(res));
}

// 运行子进程并逐行转成日志。返回 {code, stdout}
export function runProc(ctx, cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    ctx.log(`$ ${cmd} ${args.join(" ")}`, "cmd");
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", ...(opts.env || {}) },
      windowsHide: true,
    });
    let stdout = "";
    const feed = (buf, isError) => {
      const text = buf.toString("utf8");
      if (!isError) stdout += text;
      for (const line of text.split(/\r?\n|\r/)) {
        if (line.trim()) ctx.log(line, isError ? "error" : "proc");
      }
    };
    child.stdout.on("data", (b) => feed(b, false));
    child.stderr.on("data", (b) => feed(b, true));
    child.on("error", (e) => reject(new Error(`无法启动 ${cmd}：${e.message}`)));
    child.on("close", (code) => {
      if (code !== 0 && !opts.allowFail) return reject(new Error(`${cmd} 退出码 ${code}`));
      resolve({ code, stdout });
    });
  });
}
