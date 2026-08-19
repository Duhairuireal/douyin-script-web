import { errorText, fail, json, readBody, readResponseBody, requiredString } from "../_shared";

const DOUYIN_URL = /https:\/\/(?:v\.douyin\.com|www\.douyin\.com|www\.iesdouyin\.com|douyin\.com)\/[^\s<>"']+/i;

function firstUrl(value: unknown) {
  if (!value || typeof value !== "object") return "";
  const list = (value as Record<string, unknown>).url_list;
  if (!Array.isArray(list)) return "";
  return list.find((item): item is string => typeof item === "string" && item.startsWith("https://")) ?? "";
}

function parseVideo(payload: Record<string, unknown>) {
  const data = payload.data;
  if (!data || typeof data !== "object") throw new Error("TikHub 没有返回作品数据");
  const dataObject = data as Record<string, unknown>;
  let detail = dataObject.aweme_detail;
  if (!detail || typeof detail !== "object") {
    const list = dataObject.aweme_list;
    detail = Array.isArray(list) ? list[0] : undefined;
  }
  if (!detail || typeof detail !== "object") throw new Error("无法读取这条抖音作品，作品可能已删除或设为私密");

  const item = detail as Record<string, unknown>;
  const video = item.video;
  if (!video || typeof video !== "object") throw new Error("这条作品没有可处理的视频内容");
  const videoObject = video as Record<string, unknown>;
  const candidates: Array<{ rate: number; url: string }> = [];
  const bitRates = videoObject.bit_rate;
  if (Array.isArray(bitRates)) {
    for (const entry of bitRates) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as Record<string, unknown>;
      const url = firstUrl(row.play_addr);
      const rate = typeof row.bit_rate === "number" ? row.bit_rate : Number.MAX_SAFE_INTEGER;
      if (url) candidates.push({ rate, url });
    }
  }
  for (const [index, key] of ["play_addr_h264", "play_addr", "download_addr"].entries()) {
    const url = firstUrl(videoObject[key]);
    if (url) candidates.push({ rate: Number.MAX_SAFE_INTEGER - 3 + index, url });
  }
  candidates.sort((a, b) => a.rate - b.rate);
  const mediaUrl = candidates[0]?.url;
  if (!mediaUrl) throw new Error("TikHub 返回了作品信息，但没有可用的视频地址");

  const author = item.author;
  const authorName = author && typeof author === "object" ? (author as Record<string, unknown>).nickname : "";
  return {
    awemeId: String(item.aweme_id ?? "unknown"),
    title: String(item.desc ?? item.item_title ?? "未命名抖音视频"),
    author: String(authorName || "未知作者"),
    mediaUrl,
  };
}

export async function POST(request: Request) {
  try {
    const body = await readBody(request);
    const shareText = requiredString(body, "shareText");
    const apiKey = requiredString(body, "apiKey");
    const matched = shareText.match(DOUYIN_URL)?.[0]?.replace(/[),，。；;]+$/, "");
    if (!matched) {
      return fail({ service: "TikHub 抖音作品接口", reason: "没有在输入内容中找到有效的抖音链接", suggestion: "请从抖音重新复制分享链接。" });
    }

    const endpoint = new URL("https://api.tikhub.io/api/v1/douyin/app/v3/fetch_one_video_by_share_url");
    endpoint.searchParams.set("share_url", matched);
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    const payload = await readResponseBody(response);
    const code = typeof payload.code === "number" ? payload.code : response.status;
    if (!response.ok || code < 200 || code >= 300) {
      return fail({
        service: "TikHub 抖音作品接口",
        status: `HTTP ${response.status}`,
        reason: errorText(payload),
        suggestion: response.status === 401 ? "检查 TikHub API Key、套餐和接口权限。" : "检查链接是否公开，并稍后重试。",
      }, response.status === 401 ? 401 : 502);
    }
    return json(parseVideo(payload));
  } catch (error) {
    return fail({ service: "TikHub 抖音作品接口", reason: error instanceof Error ? error.message : "解析作品失败" }, 400);
  }
}
