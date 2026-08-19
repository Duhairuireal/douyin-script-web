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
    const providerName = typeof body.providerName === "string" && body.providerName.trim() ? body.providerName.trim().slice(0, 80) : "AI 总结接口";
    const thinking = body.thinking === "high" || body.thinking === "max" ? body.thinking : "disabled";
    const transcript = requiredString(body, "transcript");
    if (transcript.length > 450_000) throw new Error("文字稿过长，请分段处理");
    const source = body.source && typeof body.source === "object" ? body.source as Record<string, unknown> : {};
    const requestPayload: Record<string, unknown> = {
      model,
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
    };
    if (model === "deepseek-v4-flash" || model === "deepseek-v4-pro") {
      requestPayload.thinking = { type: thinking === "disabled" ? "disabled" : "enabled" };
      if (thinking !== "disabled") requestPayload.reasoning_effort = thinking;
    }

    const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
    if (baseUrl.includes("openrouter.ai")) {
      headers["HTTP-Referer"] = "https://douyin-script-ai-2026.niumiaomiao.chatgpt.site";
      headers["X-Title"] = "抖音成稿";
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(requestPayload),
    });
    const payload = await readResponseBody(response);
    if (!response.ok) {
      return fail({
        service: providerName,
        status: `HTTP ${response.status}`,
        reason: errorText(payload),
        suggestion: response.status === 401 ? `检查 ${providerName} 的 API Key。` : response.status === 429 ? "免费额度或调用频率已达到限制，请稍后重试或切换模型。" : "检查 API 地址、模型 ID 和该模型的账户权限。",
      }, response.status === 401 ? 401 : 502);
    }
    const summary = extractSummary(payload);
    if (!summary) return fail({ service: providerName, reason: "接口返回成功，但没有找到总结内容", suggestion: "检查模型是否支持 chat/completions。" }, 502);
    return json({ summary, resolvedModel: typeof payload.model === "string" ? payload.model : model });
  } catch (error) {
    return fail({ service: "AI 总结接口", reason: error instanceof Error ? error.message : "总结失败" }, 400);
  }
}
