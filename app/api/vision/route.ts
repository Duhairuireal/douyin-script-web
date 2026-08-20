import { errorText, fail, json, publicHttpsBase, readBody, readResponseBody, requiredString } from "../_shared";

function extractText(payload: Record<string, unknown>) {
  const choices = payload.choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return "";
  const message = (choices[0] as Record<string, unknown>).message;
  if (!message || typeof message !== "object") return "";
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.map((item) => item && typeof item === "object" ? (item as Record<string, unknown>).text : "")
    .filter((item): item is string => typeof item === "string")
    .join("\n")
    .trim();
}

export async function POST(request: Request) {
  try {
    const body = await readBody(request);
    const apiKey = requiredString(body, "apiKey");
    const baseUrl = publicHttpsBase(requiredString(body, "baseUrl"));
    const model = requiredString(body, "model");
    const providerName = typeof body.providerName === "string" && body.providerName.trim() ? body.providerName.trim().slice(0, 80) : "图片文字识别模型";
    const title = typeof body.title === "string" ? body.title.slice(0, 500) : "抖音图文作品";
    const images = Array.isArray(body.images)
      ? body.images.filter((item): item is string => typeof item === "string" && item.startsWith("https://")).slice(0, 20)
      : [];
    if (!images.length) throw new Error("作品中没有找到可读取的图片");

    const content: Array<Record<string, unknown>> = [{
      type: "text",
      text: `这是抖音图文作品《${title}》。请按图片顺序完整提取图片中的中文文字，保留段落和列表；相邻图片的重复句只保留一次。不要总结、改写或补充。最后附上作品标题中存在、但图片里没有出现的有效文字。`,
    }];
    for (const url of images) content.push({ type: "image_url", image_url: { url } });

    const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
    if (baseUrl.includes("openrouter.ai")) {
      headers["HTTP-Referer"] = new URL(request.url).origin;
      headers["X-Title"] = "视频成稿";
    }
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, messages: [{ role: "user", content }] }),
    });
    const payload = await readResponseBody(response);
    if (!response.ok) {
      return fail({
        service: providerName,
        status: `HTTP ${response.status}`,
        reason: errorText(payload),
        suggestion: response.status === 401
          ? `检查 ${providerName} 的 API Key。`
          : "当前模型可能不支持图片输入。可切换到 OpenRouter 免费总结，或使用支持视觉的自定义模型。",
      }, response.status === 401 ? 401 : 502);
    }
    const transcript = extractText(payload);
    if (!transcript) return fail({ service: providerName, reason: "模型返回成功，但没有识别出图片文字" }, 502);
    return json({ transcript, resolvedModel: typeof payload.model === "string" ? payload.model : model });
  } catch (error) {
    return fail({ service: "抖音图文识别", reason: error instanceof Error ? error.message : "图片文字识别失败" }, 400);
  }
}
