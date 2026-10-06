// dsh-seedance-video — 火山引擎方舟 Seedance（即梦）文生视频工具
// 用法：环境变量 ARK_API_KEY 设为火山引擎方舟 API Key 后，
//       在对话里让 agent 调用 video_generate(prompt, ...)。
export const name = "dsh-seedance-video";

const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const DEFAULT_MODEL = "doubao-seedance-1-0-pro-250528";
const POLL_INTERVAL_MS = 5000;
const TIMEOUT_MS = 600000; // 10 分钟
const ERROR_LIMIT = 8192;

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("aborted")); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
  });
}

async function readBoundedText(response, maxBytes) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) throw new Error(`response exceeded ${String(maxBytes)} byte limit`);
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(joined);
}

async function submitTask(baseURL, apiKey, model, prompt, signal) {
  const res = await fetch(`${baseURL}/contents/generations/tasks`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, content: [{ type: "text", text: prompt }] }),
  });
  const text = await readBoundedText(res, ERROR_LIMIT);
  if (!res.ok) throw new Error(`Seedance 任务创建失败 (${String(res.status)}): ${text.slice(0, 2000)}`);
  let json;
  try { json = JSON.parse(text); } catch { throw new Error("Seedance 返回了无效 JSON"); }
  const id = json.id;
  if (typeof id !== "string" || id.length === 0) throw new Error(`Seedance 未返回任务 id: ${text.slice(0, 2000)}`);
  return id;
}

async function pollTask(baseURL, apiKey, taskId, signal) {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`Seedance 任务 ${taskId} 超时（${String(Math.round(TIMEOUT_MS / 1000))} 秒）`);
    await delay(POLL_INTERVAL_MS, signal);
    const res = await fetch(`${baseURL}/contents/generations/tasks/${encodeURIComponent(taskId)}`, {
      method: "GET",
      signal,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const text = await readBoundedText(res, ERROR_LIMIT);
    if (!res.ok) throw new Error(`Seedance 轮询失败 (${String(res.status)}): ${text.slice(0, 2000)}`);
    let json;
    try { json = JSON.parse(text); } catch { throw new Error("Seedance 轮询返回了无效 JSON"); }
    if (json.status === "succeeded") {
      const url = json.content?.video_url;
      if (typeof url !== "string" || url.length === 0) throw new Error("Seedance 任务成功但未返回 video_url");
      return url;
    }
    if (json.status === "failed" || json.status === "cancelled") {
      throw new Error(`Seedance 任务 ${json.status}: ${json.error?.message ?? text.slice(0, 2000)}`);
    }
  }
}

function buildPrompt(prompt, size, duration) {
  let text = prompt;
  if (size && !/--(?:ratio|rt)\b/.test(text)) text += ` --ratio ${size}`;
  if (duration && !/--(?:dur|duration)\b/.test(text)) text += ` --dur ${duration}`;
  return text;
}

const toolDefinition = {
  name: "video_generate",
  description: "用火山引擎方舟 Seedance（即梦）模型文生视频。提交异步任务并轮询至完成，返回视频 URL。需要环境变量 ARK_API_KEY 已设置为你的火山引擎方舟 API Key。适合短视频、动画、产品演示、概念视频。",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      prompt: { type: "string", description: "视频描述：场景、主体、动作、镜头运动、风格、时长等，越具体越好。" },
      model: { type: "string", description: `模型 id，默认 ${DEFAULT_MODEL}。` },
      size: { type: "string", description: "可选画面比例，如 16:9 / 9:16 / 1:1（自动追加为 --ratio）。" },
      duration: { type: "string", description: "可选时长（秒），如 5 / 10（自动追加为 --dur）。" },
      base_url: { type: "string", description: `可选 Ark 端点，默认 ${DEFAULT_BASE_URL}。` },
    },
    required: ["prompt"],
  },
  output: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        video_url: { type: "string" },
        task_id: { type: "string" },
        model: { type: "string" },
      },
      required: ["video_url", "task_id", "model"],
    },
    render(_args, value) {
      return [{ type: "text", text: `视频已生成（${value.model}）：\n${value.video_url}\n\n任务 id：${value.task_id}` }];
    },
  },
  async execute(args, exec) {
    const apiKey = process.env.ARK_API_KEY;
    if (!apiKey) throw new Error("环境变量 ARK_API_KEY 未设置。请到火山引擎方舟（console.volcengine.com/ark）开通并获取 API Key，然后设置环境变量 ARK_API_KEY。");
    const baseURL = typeof args.base_url === "string" && args.base_url ? args.base_url : DEFAULT_BASE_URL;
    const model = typeof args.model === "string" && args.model ? args.model : DEFAULT_MODEL;
    const prompt = buildPrompt(args.prompt, args.size, args.duration);
    const taskId = await submitTask(baseURL, apiKey, model, prompt, exec.signal);
    const videoUrl = await pollTask(baseURL, apiKey, taskId, exec.signal);
    return { video_url: videoUrl, task_id: taskId, model };
  },
};

export function apply(ctx) {
  ctx.tools.register(toolDefinition);
}
