import { errorText, fail, readResponseBody } from "../_shared";

const API_ROOT = "https://api.tikhub.io/api/v1/bilibili/web";

export async function tikhubGet(path: string, apiKey: string, params: Record<string, string>) {
  const endpoint = new URL(`${API_ROOT}/${path}`);
  for (const [key, value] of Object.entries(params)) endpoint.searchParams.set(key, value);
  const response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  const payload = await readResponseBody(response);
  const code = typeof payload.code === "number" ? payload.code : response.status;
  if (!response.ok || code < 200 || code >= 300) {
    return {
      error: fail({
        service: "TikHub B站接口",
        status: `HTTP ${response.status}`,
        reason: errorText(payload),
        suggestion: response.status === 401
          ? "检查 TikHub API Key、余额和 B站接口权限。"
          : "检查主页或作品是否公开，并稍后重试。",
      }, response.status === 401 ? 401 : 502),
    };
  }
  return { payload };
}

export function findArrayByKey(value: unknown, key: string): unknown[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (Array.isArray(row[key])) return row[key] as unknown[];
  for (const child of Object.values(row)) {
    if (!child || typeof child !== "object") continue;
    const found = findArrayByKey(child, key);
    if (found) return found;
  }
  return undefined;
}

export function findObjectWithKey(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (key in row) return row;
  for (const child of Object.values(row)) {
    if (!child || typeof child !== "object") continue;
    const found = findObjectWithKey(child, key);
    if (found) return found;
  }
  return undefined;
}

export function firstHttps(value: unknown): string {
  if (typeof value === "string") {
    const normalized = value.startsWith("//") ? `https:${value}` : value;
    return normalized.startsWith("https://") ? normalized : "";
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = firstHttps(child);
      if (found) return found;
    }
    return "";
  }
  if (!value || typeof value !== "object") return "";
  const row = value as Record<string, unknown>;
  for (const key of ["baseUrl", "base_url", "url", "subtitle_url", "subtitleUrl", "backupUrl", "backup_url"]) {
    const found = firstHttps(row[key]);
    if (found) return found;
  }
  return "";
}

export function cleanTitle(value: unknown) {
  return String(value ?? "未命名视频")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}
