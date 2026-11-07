// app.js — haoke 作业流水线面板（无构建、原生 JS）
"use strict";

/* ---------------- 基础工具 ---------------- */
const $ = (sel, el = document) => el.querySelector(sel);
const app = $("#app");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: opts.body && !(opts.body instanceof FormData) ? { "content-type": "application/json" } : {},
    ...opts,
    body: opts.body && typeof opts.body !== "string" && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, isErr = false) {
  const t = document.createElement("div");
  t.className = "toast" + (isErr ? " err" : "");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

function confirmModal(title, bodyHtml, okText = "确定", okClass = "primary") {
  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "modal-mask";
    mask.innerHTML = `<div class="modal"><h3>${esc(title)}</h3><div>${bodyHtml}</div>
      <div class="actions"><button class="btn" data-x>取消</button>
      <button class="btn ${okClass}" data-ok>${esc(okText)}</button></div></div>`;
    mask.addEventListener("click", (e) => {
      if (e.target === mask || e.target.closest("[data-x]")) { mask.remove(); resolve(false); }
      if (e.target.closest("[data-ok]")) { mask.remove(); resolve(true); }
    });
    $("#overlays").appendChild(mask);
  });
}

function lightbox(path) {
  const lb = document.createElement("div");
  lb.className = "lightbox";
  lb.innerHTML = `<span class="x">✕</span><img src="/api/file?path=${encodeURIComponent(path)}">`;
  lb.addEventListener("click", () => lb.remove());
  $("#overlays").appendChild(lb);
}

// 极简 markdown：标题 / 表格 / 列表 / 粗体 / 行内码
function miniMd(src) {
  const inline = (s) => s
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
  const lines = esc(src || "").split(/\r?\n/);
  let html = "", inTable = false;
  const closeTable = () => { if (inTable) { html += "</tbody></table>"; inTable = false; } };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\|.*\|$/.test(l)) {
      if (/^\|[\s:|-]+\|$/.test(l)) continue;
      const cells = l.slice(1, -1).split("|").map((c) => `<td>${c.trim()}</td>`).join("");
      if (!inTable) { html += '<table class="mdtable"><tbody>'; inTable = true; }
      html += `<tr>${cells}</tr>`;
      continue;
    }
    closeTable();
    let h;
    if ((h = /^### (.*)/.exec(l))) html += `<h4>${h[1]}</h4>`;
    else if ((h = /^## (.*)/.exec(l))) html += `<h4>${h[1]}</h4>`;
    else if ((h = /^# (.*)/.exec(l))) html += `<h3>${h[1]}</h3>`;
    else if (/^[-*] /.test(l)) html += `<div>• ${inline(l.slice(2))}</div>`;
    else if (l.trim() === "") html += "<div style='height:6px'></div>";
    else html += `<div>${inline(l)}</div>`;
  }
  closeTable();
  return html;
}

function gallery(paths, capFn) {
  if (!paths.length) return `<div class="hint">（暂无图片）</div>`;
  return `<div class="gallery">${paths.map((p) =>
    `<div class="g" data-img="${esc(p)}"><img loading="lazy" src="/api/file?path=${encodeURIComponent(p)}">
     <div class="cap">${esc(capFn ? capFn(p) : p.split(/[\\/]/).pop())}</div></div>`).join("")}</div>`;
}

/* ---------------- 日志抽屉 ---------------- */
const drawer = {
  es: null,
  open(title, jobId) {
    $("#drawer").style.display = "";
    if (!jobId) return; // 只开抽屉不挂流（runCleanJob 里会马上再挂）
    $("#drawer-title").textContent = title;
    $("#drawer-status").innerHTML = '<span class="spin"></span> 运行中';
    $("#drawer-body").innerHTML = "";
    $("#drawer").classList.add("open");
    $("#drawer-toggle").textContent = "收起 ▾";
    if (this.es) this.es.close();
    const es = new EventSource(`/api/jobs/${jobId}/stream`);
    this.es = es;
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      if (ev.type === "log") this.log(ev.text, ev.level);
      else if (ev.type === "status") this.status(ev.status, ev);
    };
    es.onerror = () => { es.close(); if (this.es === es) this.es = null; };
  },
  log(text, level = "info") {
    const b = $("#drawer-body");
    const d = document.createElement("div");
    d.className = "l " + (level === "cmd" ? "cmd" : level === "error" ? "error" : level === "proc" ? "proc" : "info");
    d.textContent = text;
    b.appendChild(d);
    b.scrollTop = b.scrollHeight;
  },
  status(status, ev) {
    if (status === "done") {
      $("#drawer-status").innerHTML = '<span style="color:#34d399">✔ 完成</span>';
      if (this.es) this.es.close(), (this.es = null);
      onJobDone(ev);
    } else if (status === "error") {
      $("#drawer-status").innerHTML = '<span style="color:#f87171">✖ 出错</span>';
      if (this.es) this.es.close(), (this.es = null);
    }
  },
};
$("#drawer-head").addEventListener("click", () => {
  const d = $("#drawer");
  const open = d.classList.toggle("open");
  $("#drawer-toggle").textContent = open ? "收起 ▾" : "展开 ▴";
});

/* ---------------- 路由 ---------------- */
let detail = null;
let detailPath = "";
let activeStep = 0;
let pollTimer = null;

window.addEventListener("hashchange", route);
route();

function route() {
  const h = location.hash || "#/";
  clearInterval(pollTimer);
  if (h.startsWith("#/settings")) return viewSettings();
  if (h.startsWith("#/a?")) {
    const q = new URLSearchParams(h.slice(4));
    return viewDetail(q.get("path"));
  }
  viewList();
}

async function refreshKeyTag() {
  try {
    const s = await api("/api/settings");
    const el = $("#keytag");
    el.textContent = s.hasKey ? "API Key 已配置" : "未配置 API Key";
    el.className = "keytag" + (s.hasKey ? "" : " bad");
  } catch {}
}

/* ---------------- 作业列表 ---------------- */
async function viewList() {
  document.title = "haoke 作业流水线";
  $("#nav-list").classList.add("active");
  $("#nav-settings").classList.remove("active");
  app.innerHTML = `<div class="card"><div class="btnrow">
      <button class="btn primary" data-act="new">＋ 新建作业</button>
      <button class="btn" data-act="refresh">刷新</button>
      <span class="hint" id="scan-hint"></span>
    </div></div><div id="list-body" class="empty">扫描中…</div>`;
  const load = async () => {
    try {
      const { assignments } = await api("/api/assignments");
      $("#list-body").className = "";
      $("#list-body").innerHTML = assignments.length ? `<div class="grid">${assignments.map(cardHtml).join("")}</div>`
        : `<div class="empty">没扫到作业 —— 检查设置页的「作业根目录」</div>`;
      $("#scan-hint").textContent = `根目录下共 ${assignments.length} 份作业`;
    } catch (e) {
      $("#list-body").innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  };
  const cardHtml = (a) => {
    const chips = [];
    if (a.captured.length) chips.push(`<span class="chip on">已抓 ${a.captured.length} 题</span>`);
    if (a.proofread) chips.push(`<span class="chip on">已校对</span>`);
    if (a.pdfs.length) chips.push(`<span class="chip mid">手写稿 ×${a.pdfs.length}</span>`);
    if (a.sliced.length) chips.push(`<span class="chip on">已切片 ${a.sliced.length}</span>`);
    if (a.latexImages.length) chips.push(`<span class="chip on">LaTeX ${a.latexImages.length} 题</span>`);
    if (a.uploadState) chips.push(`<span class="chip on">已上传</span>`);
    if (a.redpenCount) chips.push(`<span class="chip on">已订正</span>`);
    if (!chips.length) chips.push(`<span class="chip">未开始</span>`);
    return `<div class="acard" data-open="${esc(a.path)}">
      <div class="course">${esc(a.course)}</div>
      <div class="name">${esc(a.name)}</div>
      <div class="chips">${chips.join("")}</div></div>`;
  };
  app.querySelectorAll("[data-act=refresh]").forEach((b) => (b.onclick = load));
  app.querySelectorAll("[data-act=new]").forEach((b) => (b.onclick = newAssignmentModal));
  app.onclick = (e) => {
    const el = e.target.closest("[data-open]");
    if (el) location.hash = `#/a?path=${encodeURIComponent(el.dataset.open)}`;
  };
  await load();
  pollTimer = setInterval(load, 8000);
}

async function newAssignmentModal() {
  const cfg = await api("/api/settings");
  const mask = document.createElement("div");
  mask.className = "modal-mask";
  mask.innerHTML = `<div class="modal"><h3>新建作业</h3>
    <div class="field"><label>课程目录（作业根目录下的子目录，可留空）</label>
      <input type="text" id="na-course" placeholder="如：高等数学（留空放根目录）" list="na-courses">
      <datalist id="na-courses"></datalist></div>
    <div class="field"><label>作业名</label><input type="text" id="na-name" placeholder="第九次作业"></div>
    <div class="field"><label>教材 / 原题 PDF 路径（可选，之后也可改）</label>
      <input type="text" id="na-textbook" value="${esc(cfg.defaultTextbook || "")}" placeholder="D:\\课程\\高等数学\\教材_课后习题.pdf"></div>
    <div class="field"><label>章节（如「习题1」；也可带页码「习题1@120-135」）</label>
      <input type="text" id="na-chapter" placeholder="习题1"></div>
    <div class="actions"><button class="btn" data-x>取消</button><button class="btn primary" data-ok>创建</button></div></div>`;
  mask.addEventListener("click", async (e) => {
    if (e.target === mask || e.target.closest("[data-x]")) return mask.remove();
    if (e.target.closest("[data-ok]")) {
      try {
        const r = await api("/api/assignments", { method: "POST", body: {
          course: $("#na-course", mask).value.trim(),
          name: $("#na-name", mask).value.trim(),
          textbook: $("#na-textbook", mask).value.trim(),
          chapter: $("#na-chapter", mask).value.trim(),
        }});
        mask.remove();
        toast("已创建：" + r.path);
        location.hash = `#/a?path=${encodeURIComponent(r.path)}`;
      } catch (err) { toast(err.message, true); }
    }
  });
  $("#overlays").appendChild(mask);
  // 课程候选
  const root = cfg.assignmentsRoot;
  fetch("/api/file?path=" + encodeURIComponent(root)).catch(() => {});
  try {
    const res = await fetch("/api/assignments");
    const { assignments } = await res.json();
    const courses = [...new Set(assignments.map((a) => a.course))];
    $("#na-courses", mask).innerHTML = courses.map((c) => `<option value="${esc(c)}">`).join("");
  } catch {}
}

/* ---------------- 设置页 ---------------- */
async function viewSettings() {
  $("#nav-settings").classList.add("active");
  $("#nav-list").classList.remove("active");
  const s = await api("/api/settings");
  app.innerHTML = `<div class="card">
    <h3>LLM（OpenAI 兼容接口）</h3>
    <div class="field"><label>Base URL</label><input type="text" id="s-base" value="${esc(s.llm.baseUrl)}" placeholder="https://api.openai.com/v1"></div>
    <div class="field"><label>API Key ${s.hasKey ? '<span class="tag ok">已配置</span>' : '<span class="tag err">未配置</span>'}</label>
      <input type="password" id="s-key" placeholder="${s.hasKey ? "已保存（留空保持不变）" : "sk-…"}"></div>
    <div class="field"><div class="row">
      <div><label>视觉模型（校对/挑行/转写/红笔）</label><input type="text" id="s-vmodel" value="${esc(s.llm.visionModel)}" placeholder="glm-4.5v / qwen-vl-max / gpt-4o"></div>
      <div><label>文本模型（留空用视觉模型）</label><input type="text" id="s-tmodel" value="${esc(s.llm.textModel)}" placeholder=""></div>
    </div></div>
    <div class="callout">AI 步骤全部走这里的接口：兼容智谱 / Qwen / OpenAI 等任何 OpenAI 兼容服务。每份作业约 30–60 次视觉调用。</div>
  </div>
  <div class="card">
    <h3>目录</h3>
    <div class="field"><label>作业根目录（扫描「课程/第N次作业」两层结构）</label>
      <input type="text" id="s-root" value="${esc(s.assignmentsRoot)}" placeholder="D:\\课程"></div>
    <div class="field"><label>默认教材 / 原题 PDF（新建作业时预填）</label>
      <input type="text" id="s-book" value="${esc(s.defaultTextbook || "")}"></div>
    <div class="field"><label>面板端口（重启生效）</label><input type="text" id="s-port" value="${s.port}"></div>
  </div>
  <div class="btnrow"><button class="btn primary" id="s-save">保存设置</button>
    <span class="hint">API Key 保存在本机 webui/config.json，服务只监听 127.0.0.1</span></div>`;
  $("#s-save").onclick = async () => {
    try {
      const body = {
        llm: {
          baseUrl: $("#s-base").value.trim(),
          visionModel: $("#s-vmodel").value.trim(),
          textModel: $("#s-tmodel").value.trim(),
        },
        assignmentsRoot: $("#s-root").value.trim(),
        defaultTextbook: $("#s-book").value.trim(),
        port: parseInt($("#s-port").value) || 8420,
      };
      const key = $("#s-key").value.trim();
      if (key) body.llm.apiKey = key;
      await api("/api/settings", { method: "PUT", body });
      toast("已保存");
      refreshKeyTag();
    } catch (e) { toast(e.message, true); }
  };
}

/* ---------------- 作业详情 ---------------- */
const STEPS = [
  { id: "cap", label: "1 抓题·校对" },
  { id: "hand", label: "2 手写稿" },
  { id: "proc", label: "3 处理" },
  { id: "up", label: "4 上传" },
  { id: "red", label: "5 订正" },
  { id: "clean", label: "6 清理" },
];

async function viewDetail(path) {
  detailPath = path;
  detail = await api(`/api/assignment/detail?path=${encodeURIComponent(path)}`);
  // 当前步：第一个未完成的
  const d = detail;
  const doneFlags = [
    d.counts.haoke > 0 && d.counts.proofs > 0,
    d.pdfs.length > 0,
    d.counts.slices > 0 || d.counts.latex > 0,
    !!d.state.upload,
    d.counts.redpen > 0,
    false,
  ];
  if (!location.hash.startsWith("#/a?")) return;
  const firstTodo = doneFlags.findIndex((f) => !f);
  if (!app.dataset.step || app.dataset.path !== path) activeStep = firstTodo === -1 ? STEPS.length - 1 : firstTodo;
  renderDetail();
}

function stepDone(i) {
  const d = detail;
  return [
    d.counts.haoke > 0 && d.counts.proofs > 0,
    d.pdfs.length > 0,
    d.counts.slices > 0 || d.counts.latex > 0,
    !!d.state.upload,
    d.counts.redpen > 0,
    false,
  ][i];
}

function renderDetail() {
  document.title = detail.name + " · haoke";
  const cur = activeStep;
  app.innerHTML = `
    <div class="card" style="padding:14px 18px">
      <div class="btnrow">
        <button class="btn sm" onclick="history.length>1?history.back():location.hash='#/'">← 返回</button>
        <b style="font-size:16px">${esc(detail.course)} / ${esc(detail.name)}</b>
        <span class="spacer" style="flex:1"></span>
        <span class="hint">${esc(detail.path)}</span>
      </div>
      <div class="stepper" style="margin:14px 0 0">
        ${STEPS.map((s, i) => `
          <div class="step ${i < cur || stepDone(i) ? "done" : ""} ${i === cur ? "cur" : ""} click" data-step="${i}">
            <div class="dot">${i < cur || stepDone(i) ? "✓" : i + 1}</div><div class="lbl">${s.label}</div>
            ${i < STEPS.length - 1 ? '<div class="bar"></div>' : ""}
          </div>`).join("")}
      </div>
    </div>
    <div id="step-panel"></div>`;
  app.querySelectorAll(".step.click").forEach((el) =>
    (el.onclick = () => { activeStep = +el.dataset.step; app.dataset.step = "1"; renderDetail(); }));
  app.dataset.path = detailPath;
  renderStepPanel();
}

function panelCard(title, inner, hint = "") {
  return `<div class="card"><h3>${title}</h3>${hint ? `<div class="hint">${hint}</div>` : ""}${inner}</div>`;
}

function renderStepPanel() {
  const el = $("#step-panel");
  const d = detail;
  const busy = (s) => jobBusyStep === s;
  const btn = (act, label, cls = "primary", dis = false, extra = "") =>
    `<button class="btn ${cls}" data-act="${act}" ${dis ? "disabled" : ""} ${extra}>${label}</button>`;
  let html = "";
  if (activeStep === 0) {
    html += panelCard("① 抓题", `
      <div class="hint">打开 haoke 作业页面（面板不代登录）：确认 Chrome 已开且已登录 jAccount，进入这份作业的<b>作答页</b>，然后点「开始抓题」。脚本会逐题截图，结束后浏览器保持打开。</div>
      ${d.counts.haoke ? `<div class="callout">已抓 <b>${d.counts.haoke}</b> 题 → ${esc(d.haokeDir)}</div>` : ""}
      <div class="btnrow" style="margin-top:8px">${btn("capture", "开始抓题", "primary", busy("capture"))}
        <span class="hint">若网站改版导致抓题失败，仍回 ZCode 处理（已提交复查页的遍历暂不支持）</span></div>`);
    html += panelCard("② 校对", `
      <div class="field"><div class="row">
        <div><label>教材 / 原题 PDF</label><input type="text" id="pf-book" value="${esc(d.state.textbook || "")}" placeholder="微积分上册_课后习题与解答.pdf 的完整路径"></div>
        <div style="max-width:220px"><label>章节（习题1 或 习题1@120-135）</label><input type="text" id="pf-chapter" value="${esc(d.state.chapter || "")}"></div>
      </div></div>
      ${d.counts.proofs ? `<div class="callout">已校对 <b>${d.counts.proofs}</b> 题，产物：${esc(d.proofsDir)}</div>` : ""}
      <div class="btnrow">${btn("proofread", d.counts.proofs ? "重新校对" : "开始校对", "primary", busy("proofread"))}
        <span class="hint">规则：选题以网页为准，细节以原题为准；缺题干/错别字/符号错误/缺图 → 裁原题替换</span></div>
      ${d.texts.duizhao ? `<details style="margin-top:10px"><summary class="hint" style="cursor:pointer">查看对照表</summary><div class="pre">${miniMd(d.texts.duizhao)}</div></details>` : ""}`);
  }
  if (activeStep === 1) {
    html += panelCard("手写稿", `
      <div class="callout">把手写解答 PDF 放进来（拍照/扫描件均可）。放好后回<b>第 3 步</b>选择「切片版」或「LaTeX 版」。</div>
      <div class="btnrow" style="margin-top:8px">
        <label class="btn primary" style="cursor:pointer;font-size:15px;padding:9px 22px">📄 上传手写稿 PDF<input type="file" id="pdf-file" accept=".pdf" style="display:none"></label>
        <span class="hint">或直接把 PDF 复制进作业目录后点「刷新」</span>
      </div>
      <div style="margin-top:10px">
        ${d.pdfs.length ? d.pdfs.map((p, i) => `<label style="display:block;padding:6px 10px;border:1px solid var(--line);border-radius:8px;margin:6px 0">
          <input type="radio" name="pdfpick" value="${esc(p)}" ${i === 0 ? "checked" : ""}> 📄 ${esc(p.split(/[\\/]/).pop())}</label>`).join("")
        : '<div class="hint">（作业目录里还没有 PDF）</div>'}
      </div>`);
  }
  if (activeStep === 2) {
    html += panelCard("手写稿处理：选一种输出", `
      <div class="hint">切片版 = 原样保留手写（快）；LaTeX 版 = 识别重排 + 对照题面验算订正（上传更整洁，慢）。两者都会逐题核对完整后与网页题号对齐。</div>
      <div class="btnrow" style="margin-top:8px">
        ${btn("split", "手写切片版", "primary", busy("split"))}
        ${btn("latex", "LaTeX 重排版", "primary", busy("latex"))}
      </div>`,
      d.pdfs.length ? `将处理：${esc(d.pdfs.map((p) => p.split(/[\\/]/).pop()).join("、"))}（在第 2 步里可确认用哪份）` : "⚠ 作业目录里还没有手写稿 PDF —— 先到第 2 步上传");
    if (d.counts.slices) {
      const issues = (d.state.lastSplit?.issues || d.state.issues || []);
      html += panelCard("切片产物", `
        ${d.sliceDirs.map((s) => `<div class="hint">${esc(s)} —— ${countN(s)} 张</div>`).join("")}
        ${d.texts.bounds ? `<details open><summary class="hint" style="cursor:pointer">边界.json（可改后点「重新切图」）</summary>
          <textarea id="bounds-edit" class="pre" style="width:100%;min-height:160px">${esc(d.texts.bounds)}</textarea>
          <div class="btnrow" style="margin-top:8px">${btn("split-recut", "保存并重新切图", "ok", busy("split"))}</div></details>` : ""}
        <div style="margin-top:10px">${gallery(d.galleries?.slices || [])}</div>`,
        issues.length ? `⚠ 总览复核疑点 ${issues.length} 条：${esc(issues.map((x) => `切片${x.slice}:${x.note}`).join("；"))}` : "");
      if (d.state.overviews?.length)
        html += panelCard("校对总览", gallery(d.state.overviews), "上排看开头（每格必须是题号）、下排看结尾");
    }
    if (d.counts.latex) {
      html += panelCard("LaTeX 产物", `
        ${d.texts.baogao ? `<div class="pre" style="max-height:260px">${miniMd(d.texts.baogao)}</div>` : ""}
        ${d.texts.latexTxt ? `<details><summary class="hint" style="cursor:pointer">作业.txt（可改后重新渲染）</summary>
          <textarea id="latex-edit" class="pre" style="width:100%;min-height:200px">${esc(d.texts.latexTxt)}</textarea>
          <div class="btnrow" style="margin-top:8px">${btn("latex-rerender", "保存并重新渲染", "ok", busy("latex"))}</div></details>` : ""}
        <div style="margin-top:10px">${gallery(latexPngs())}</div>`);
    }
  }
  if (activeStep === 3) {
    const n = (d.sliceDirs || []).reduce((a, s) => a + countN(s), 0) || d.counts.slices || d.counts.latex;
    html += panelCard("上传到 haoke", `
      <div class="callout warn">上传前请确认作业<b>尚未提交</b>（复查页没有上传控件，传不了）。上传后脚本<b>绝不替你点「提交」</b>——逐题检查完自己提交。</div>
      <div class="hint">切片来源：${esc((d.sliceDirs || []).join("；") || d.slicesDir || "—")}，共 ${n || "?"} 张（多份切片自动按顺序重命名合并）</div>
      ${d.state.upload ? `<div class="callout">上次上传：${esc(new Date(d.state.upload.at).toLocaleString())} —— ${esc((d.state.upload.results || []).join(" "))}</div>` : ""}
      <div class="btnrow" style="margin-top:8px">
        ${btn("upload", d.state.upload ? "重新上传（幂等续传）" : "开始上传", "primary", busy("upload"))}
        ${d.state.upload ? btn("upload-force", "强制重传全部", "danger", busy("upload")) : ""}
      </div>`);
  }
  if (activeStep === 4) {
    html += panelCard("红笔订正（可选，给复习用）", `
      <div class="hint">在手写切片旁边用红字写清：错在哪 → 为什么 → 正确是什么 → 结论变不变；原稿一个字不动。与上传互不影响。</div>
      <div class="btnrow" style="margin-top:8px">${btn("redpen", d.counts.redpen ? "重新生成订正" : "生成红笔订正", "primary", busy("redpen"))}</div>
      ${d.counts.redpen ? `<div class="callout">已有订正图 <b>${d.counts.redpen}</b> 张 → ${esc(d.redpenDir)}</div>
        <div style="margin-top:10px">${gallery(redpenPngs())}</div>
        ${d.texts.notes ? `<details><summary class="hint" style="cursor:pointer">红笔数据（JSON，可改后重出）</summary>
          <textarea id="notes-edit" class="pre" style="width:100%;min-height:180px">${esc(d.texts.notes)}</textarea>
          <div class="btnrow" style="margin-top:8px">${btn("redpen-rerun", "按此数据重出红笔图", "ok", busy("redpen"))}</div></details>` : ""}` : ""}`,
      d.counts.slices ? "" : "⚠ 没有手写切片 —— 订正输入是「切片版」的产物，请先做第 3 步的切片");
  }
  if (activeStep === 5) {
    html += panelCard("收尾清理", `
      <div class="hint">删除运行副产物，保留：题面图 / PDF / 最终图片切片 / 原题材料。先预览，再确认执行。</div>
      <div class="btnrow" style="margin-top:8px">
        ${btn("clean-dry", "预览将删除的内容", "", busy("clean"))}
        <button class="btn danger" data-act="clean-run" id="clean-run" disabled>确认清理</button>
      </div>
      <div id="clean-list" style="margin-top:10px"></div>`);
  }
  el.innerHTML = html;
  bindStepPanel();
}

function countN(dir) {
  if (!dir) return 0;
  const d = detail;
  if (d.sliceDirCounts) {
    const norm = (s) => String(s).replace(/[\\/]+$/, "");
    for (const [k, v] of Object.entries(d.sliceDirCounts)) if (norm(k) === norm(dir)) return v;
  }
  if (d.haokeDir && dir === d.haokeDir) return d.counts.haoke;
  if (d.proofsDir && dir === d.proofsDir) return d.counts.proofs;
  if (d.redpenDir && dir === d.redpenDir) return d.counts.redpen;
  if (d.latexDir && dir === d.latexDir + "/图片") return d.counts.latex;
  if (d.slicesDir && dir === d.slicesDir) return d.counts.slices;
  return 0;
}
// 图片清单一律用后端 detail.galleries 里的真实文件（兼容无补零/自定义后缀文件名）
const latexPngs = () => detail.galleries?.latex || [];
const redpenPngs = () => detail.galleries?.redpen || [];

/* ---------------- 步骤动作 ---------------- */
let jobBusyStep = null;

function bindStepPanel() {
  app.querySelectorAll("[data-img]").forEach((el) => (el.onclick = () => lightbox(el.dataset.img)));

  const pdfInput = $("#pdf-file");
  if (pdfInput)
    pdfInput.onchange = async () => {
      const f = pdfInput.files[0];
      if (!f) return;
      try {
        const buf = await f.arrayBuffer();
        const res = await fetch(`/api/upload/pdf?path=${encodeURIComponent(detailPath)}&name=${encodeURIComponent(f.name)}`, {
          method: "POST", headers: { "content-type": "application/octet-stream" }, body: buf,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "上传失败");
        toast(`已放入：${data.file}`);
        await reloadDetail();
      } catch (e) { toast(e.message, true); }
    };

  app.querySelectorAll("[data-act]").forEach((b) => {
    const act = b.dataset.act;
    const handlers = {
      capture: () => startStep("capture", { path: detailPath }),
      proofread: () => startStep("proofread", { path: detailPath, textbook: $("#pf-book")?.value.trim(), chapter: $("#pf-chapter")?.value.trim() }),
      split: () => startStep("split", { path: detailPath }),
      latex: () => startStep("latex", { path: detailPath }),
      upload: () => startStep("upload", { path: detailPath }),
      "upload-force": () => startStep("upload", { path: detailPath, force: true }),
      redpen: () => startStep("redpen", { path: detailPath }),
      "clean-dry": () => runCleanJob(true),
      "clean-run": () => runCleanJob(false),
      "split-recut": () => {
        const bounds = JSON.parse($("#bounds-edit").value);
        startStep("split-recut", { path: detailPath, bounds });
      },
      "latex-rerender": () => saveThen("/api/text", { path: detail.latexDir + "/latex/作业.txt", content: $("#latex-edit").value }, () =>
        startStep("latex-rerender", { path: detailPath })),
      "redpen-rerun": () => startStep("redpen-rerun", { path: detailPath, notes: JSON.parse($("#notes-edit").value) }),
    };
    if (handlers[act]) b.onclick = () => { try { handlers[act](); } catch (e) { toast(e.message, true); } };
  });
}

async function saveThen(url, body, then) {
  await api(url, { method: "PUT", body });
  toast("已保存");
  then();
}

async function startStep(step, body) {
  try {
    const r = await api(`/api/steps/${step}`, { method: "POST", body });
    jobBusyStep = step;
    drawer.open(stepTitle(step), r.jobId);
    app.dataset.step = "1";
  } catch (e) {
    toast(e.message, true);
    if (String(e.message).includes("API Key") || String(e.message).includes("视觉模型"))
      location.hash = "#/settings";
  }
}

function stepTitle(step) {
  return ({
    capture: "抓题", proofread: "校对", split: "切片", "split-recut": "重新切图",
    latex: "LaTeX 转写", "latex-rerender": "重新渲染", upload: "上传", redpen: "红笔订正",
    "redpen-rerun": "重出红笔图", clean: "清理",
  })[step] || step;
}

async function runCleanJob(dry) {
  if (!dry) {
    const okFlag = await confirmModal("确认清理",
      `<div class="callout err">将按 hw_clean 的规则删除运行副产物（保留题面图 / PDF / 最终切片 / 原题材料）。删除不可恢复。</div>`,
      "确认清理", "danger");
    if (!okFlag) return;
  }
  jobBusyStep = "clean";
  try {
    const r = await api("/api/steps/clean", { method: "POST", body: { path: detailPath, dry } });
    drawer.open("清理" + (dry ? "（预览）" : ""), r.jobId);
  } catch (e) {
    toast(e.message, true);
  }
}

async function reloadDetail() {
  detail = await api(`/api/assignment/detail?path=${encodeURIComponent(detailPath)}`);
  renderDetail();
}

function onJobDone(ev) {
  jobBusyStep = null;
  // 上传结果单独提示
  if (ev?.result?.results) {
    const okCount = ev.result.results.filter((s) => s.endsWith(":OK")).length;
    const skip = ev.result.results.filter((s) => s.endsWith(":skip")).length;
    toast(`上传完成：${okCount} 成功 / ${skip} 跳过。请到浏览器逐题检查后【自行提交】！`);
  }
  if (location.hash.startsWith("#/a?")) reloadDetail();
  else if (location.hash === "#/" || location.hash === "") viewList();
}

refreshKeyTag();
