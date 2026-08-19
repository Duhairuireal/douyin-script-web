import { errorText, extractTranscript, fail, json, readBody, readResponseBody, requiredString, responseHeader } from "../../_shared";

const QUERY_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query";

export async function POST(request: Request) {
  try {
    const body = await readBody(request);
    const taskId = requiredString(body, "taskId");
    const apiKey = requiredString(body, "apiKey");
    const resourceId = requiredString(body, "resourceId");
    const logId = typeof body.logId === "string" ? body.logId.trim() : "";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
      "X-Api-Resource-Id": resourceId,
      "X-Api-Request-Id": taskId,
    };
    if (logId) headers["X-Tt-Logid"] = logId;

    const response = await fetch(QUERY_URL, { method: "POST", headers, body: "{}" });
    const payload = await readResponseBody(response);
    const statusCode = responseHeader(response, "X-Api-Status-Code");
    const message = responseHeader(response, "X-Api-Message") || errorText(payload);

    if (statusCode === "20000000") {
      const transcript = extractTranscript(payload);
      if (!transcript) return fail({ service: "火山豆包 ASR 录音文件识别 2.0", reason: "识别任务完成，但结果中没有文字", requestId: taskId }, 502);
      return json({ state: "done", transcript });
    }
    if (response.ok && ["20000001", "20000002"].includes(statusCode)) return json({ state: "pending" });

    return fail({
      service: "火山豆包 ASR 录音文件识别 2.0",
      status: statusCode ? `业务状态码 ${statusCode}` : `HTTP ${response.status}`,
      reason: message,
      suggestion: message.includes("not granted") ? "检查录音文件识别 2.0 是否已经开通。" : "检查 API Key、资源 ID，或稍后重试。",
      requestId: taskId,
    }, response.status === 401 || response.status === 403 ? response.status : 502);
  } catch (error) {
    return fail({ service: "火山豆包 ASR 录音文件识别 2.0", reason: error instanceof Error ? error.message : "查询识别失败" }, 400);
  }
}
