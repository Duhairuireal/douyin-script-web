import { errorText, extractTranscript, fail, json, readBody, readResponseBody, requiredString, responseHeader } from "../../_shared";

const SUBMIT_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit";

export async function POST(request: Request) {
  let taskId = "";
  try {
    const body = await readBody(request);
    const mediaUrl = requiredString(body, "mediaUrl");
    const apiKey = requiredString(body, "apiKey");
    const resourceId = requiredString(body, "resourceId");
    if (!mediaUrl.startsWith("https://")) throw new Error("视频地址必须使用 HTTPS");
    taskId = crypto.randomUUID();
    const response = await fetch(SUBMIT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
        "X-Api-Resource-Id": resourceId,
        "X-Api-Request-Id": taskId,
        "X-Api-Sequence": "-1",
      },
      body: JSON.stringify({
        user: { uid: "douyin-script-web" },
        audio: { url: mediaUrl, format: "mp4" },
        request: { model_name: "bigmodel", enable_itn: true, enable_punc: true, show_utterances: true },
      }),
    });
    const payload = await readResponseBody(response);
    const statusCode = responseHeader(response, "X-Api-Status-Code");
    const message = responseHeader(response, "X-Api-Message") || errorText(payload);
    const logId = responseHeader(response, "X-Tt-Logid");
    const transcript = extractTranscript(payload);

    if (!response.ok || !["20000000", "20000001", "20000002"].includes(statusCode)) {
      return fail({
        service: "火山豆包 ASR 录音文件识别 2.0",
        status: statusCode ? `业务状态码 ${statusCode}` : `HTTP ${response.status}`,
        reason: message,
        suggestion: statusCode === "45000030" || message.includes("not granted") ? "当前 Key 没有开通这个资源，请在豆包语音控制台开通录音文件识别 2.0。" : "检查 ASR API Key、资源 ID 和服务权限。",
        requestId: taskId,
      }, response.status === 401 || response.status === 403 ? response.status : 502);
    }
    return json({ state: transcript ? "done" : "pending", taskId, logId, transcript: transcript || undefined });
  } catch (error) {
    return fail({ service: "火山豆包 ASR 录音文件识别 2.0", reason: error instanceof Error ? error.message : "提交识别失败", requestId: taskId || undefined }, 400);
  }
}
