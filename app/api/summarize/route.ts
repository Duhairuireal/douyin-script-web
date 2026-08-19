import { errorText, fail, json, publicHttpsBase, readBody, readResponseBody, requiredString } from "../_shared";

function extractSummary(payload: Record<string, unknown>) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) return payload.output_text.trim();
  const choices = payload.choices;
  if (!Array.isArray(choices) || !choices.length || !choices[0] || typeof choices[0] !== "object") return "";
  const message = (choices[0] as Record<string, unknown>).message;
  if (!message || typeof message !== "object") return "";
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.map((item) => item && typeof item === "object" ? (item as Record<string, unknown>).text : "").filter((item): item is string => typeof item === "string").join("").trim();
}

export async function POST(request: Request) {
  try {
    const body = await readBody(request);
    const apiKey = requiredString(body, "apiKey");
    const baseUrl = publicHttpsBase(requiredString(body, "baseUrl"));
    const model = requiredString(body, "model");
    const transcript = requiredString(body, "transcript");
    if (transcript.length > 450_000) throw new Error("文字稿过长，请分段处理");
    const source = body.source && typeof body.source === "object" ? body.source as Record<string, unknown> : {};
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: "你是严谨的中文内容编辑。只根据提供的文字稿总结，不补充未出现的事实。输出固定结构：一句话概括、核心要点、关键数字与专有名词、可行动信息。使用清晰的 Markdown，语言简洁。",
          },
          {
            role: "user",
            content: `视频标题：${String(source.title ?? "未命名视频")}\n作者：${String(source.author ?? "未知作者")}\n\n文字稿：\n${transcript}`,
          },
        ],
      }),
    });
    const payload = await readResponseBody(response);
    if (!response.ok) {
      return fail({
        service: "DeepSeek 总结接口",
        status: `HTTP ${response.status}`,
        reason: errorText(payload),
        suggestion: response.status === 401 ? "检查 DeepSeek API Key。" : "检查 API 地址和模型名称。",
      }, response.status === 401 ? 401 : 502);
    }
    const summary = extractSummary(payload);
    if (!summary) return fail({ service: "DeepSeek 总结接口", reason: "接口返回成功，但没有找到总结内容", suggestion: "检查模型是否支持 chat/completions。" }, 502);
    return json({ summary });
  } catch (error) {
    return fail({ service: "DeepSeek 总结接口", reason: error instanceof Error ? error.message : "总结失败" }, 400);
  }
}
