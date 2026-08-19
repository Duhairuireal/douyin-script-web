export type ApiErrorDetail = {
  service: string;
  status?: string;
  reason: string;
  suggestion?: string;
  requestId?: string;
};

export function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export function fail(detail: ApiErrorDetail, status = 400) {
  return json({ error: detail }, status);
}

export async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    throw new Error("请求内容不是有效的 JSON");
  }
}

export async function readResponseBody(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text.slice(0, 1000) };
  }
}

export function requiredString(body: Record<string, unknown>, key: string) {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`缺少参数：${key}`);
  return value.trim();
}

export function responseHeader(response: Response, name: string) {
  return response.headers.get(name)?.trim() ?? "";
}

export function errorText(payload: Record<string, unknown>) {
  const header = payload.header;
  if (header && typeof header === "object") {
    const message = (header as Record<string, unknown>).message;
    if (typeof message === "string" && message) return message;
  }
  const error = payload.error;
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message) return message;
  }
  for (const key of ["message_zh", "message", "error_msg", "detail", "raw"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "服务器没有返回具体原因";
}

export function extractTranscript(payload: Record<string, unknown>) {
  const result = payload.result;
  if (!result || typeof result !== "object") return "";
  const resultObject = result as Record<string, unknown>;
  if (typeof resultObject.text === "string" && resultObject.text.trim()) return resultObject.text.trim();
  const utterances = resultObject.utterances;
  if (!Array.isArray(utterances)) return "";
  return utterances
    .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>).text : ""))
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .join("\n")
    .trim();
}

export function publicHttpsBase(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("总结 API 地址格式不正确");
  }
  if (parsed.protocol !== "https:") throw new Error("总结 API 地址必须使用 HTTPS");
  const host = parsed.hostname.toLowerCase();
  const privateHost =
    host === "localhost" || host === "0.0.0.0" || host === "::1" ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.endsWith(".local");
  if (privateHost) throw new Error("总结 API 地址不能指向本机或局域网");
  return value.replace(/\/+$/, "");
}
