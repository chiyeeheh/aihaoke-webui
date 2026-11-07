// llm.mjs — OpenAI 兼容 chat/completions 客户端（视觉 + JSON 输出）
// 兼容智谱 open.bigmodel.cn/api/paas/v4、Qwen compatible-mode、OpenAI 等。
import { readFileSync } from "node:fs";
import { loadConfig } from "./paths.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class LlmError extends Error {}

function cfg() {
  const c = loadConfig();
  if (!c.llm.apiKey) throw new LlmError("还没配置 API Key —— 请到「设置」页填写后再跑 AI 步骤。");
  if (!c.llm.visionModel) throw new LlmError("还没配置视觉模型 —— 请到「设置」页填写（如 glm-4.5v / qwen-vl-max / gpt-4o）。");
  return c;
}

export function textModel() {
  const c = cfg();
  return c.llm.textModel || c.llm.visionModel;
}

// 图片 → data URL。imgPath 为本地文件路径。
export function imageDataUrl(imgPath, mime = "image/png") {
  const b64 = readFileSync(imgPath).toString("base64");
  return `data:${mime};base64,${b64}`;
}

// 组消息：content 数组形式（文本 + 若干图片）
export function visionMessage(text, imgPaths = [], mimeMap = {}) {
  const content = [{ type: "text", text }];
  for (const p of imgPaths)
    content.push({ type: "image_url", image_url: { url: imageDataUrl(p, mimeMap[p] || "image/png") } });
  return { role: "user", content };
}

async function postChat(body, baseUrl, apiKey) {
  const url = baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 300_000); // 单次调用 5 分钟上限
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 500);
      try {
        msg = JSON.parse(text)?.error?.message || msg;
      } catch {}
      throw Object.assign(new LlmError(`LLM HTTP ${res.status}: ${msg}`), { status: res.status });
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

// 基础调用：messages 数组进，字符串回复出
export async function chat(messages, { model, json = false, temperature } = {}) {
  const c = cfg();
  const body = {
    model: model || c.llm.visionModel,
    messages,
    temperature: temperature ?? c.llm.temperature,
    stream: false,
  };
  if (json) body.response_format = { type: "json_object" };

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const data = await postChat(body, c.llm.baseUrl, c.llm.apiKey);
      const msg = data?.choices?.[0]?.message;
      const txt = typeof msg?.content === "string" ? msg.content : (msg?.content || []).map((p) => p.text || "").join("");
      if (!txt) throw new LlmError("LLM 返回了空内容");
      return txt.trim();
    } catch (e) {
      lastErr = e;
      const retryable = e.status === 429 || e.status >= 500 || e.name === "AbortError" || e.name === "TypeError";
      if (!retryable || attempt === 3) throw e;
      await sleep(1500 * attempt * attempt);
    }
  }
  throw lastErr;
}

// JSON 调用：要求模型只输出 JSON，做围栏剥离与容错解析；解析失败带着错误反馈重试一次
export async function chatJson(messages, { model, temperature } = {}) {
  const msgs = [
    ...messages,
    { role: "system", content: "只输出一个合法 JSON，不要任何解释、不要 markdown 代码围栏。" },
  ];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const txt = await chat(msgs, { model, temperature, json: attempt === 1 });
    try {
      return parseJsonLoose(txt);
    } catch (e) {
      if (attempt === 2) throw new LlmError(`LLM 输出无法解析为 JSON：${txt.slice(0, 300)}`);
      msgs.push({ role: "assistant", content: txt });
      msgs.push({ role: "user", content: `上面的输出不是合法 JSON（${e.message}）。重新输出，只给 JSON 本体。` });
    }
  }
}

export function parseJsonLoose(txt) {
  let t = txt.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {}
  // 容错：抓第一个 { 到最后一个 }（或 [ ]）
  const s = t.search(/[{[]/);
  const e = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (s >= 0 && e > s) return JSON.parse(t.slice(s, e + 1));
  throw new Error("找不到 JSON 主体");
}
