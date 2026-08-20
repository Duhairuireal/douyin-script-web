import { fail, json, readBody, requiredString } from "../../_shared";
import { cleanTitle, findArrayByKey, findObjectWithKey, tikhubGet } from "../_shared";

function extractUid(input: string) {
  if (/^\d{3,20}$/.test(input.trim())) return input.trim();
  const matched = input.match(/space\.bilibili\.com\/(\d{3,20})/i);
  return matched?.[1] ?? "";
}

function parseDuration(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value));
  if (typeof value !== "string") return 0;
  const parts = value.split(":").map(Number);
  if (parts.some((item) => !Number.isFinite(item))) return 0;
  return parts.reduce((total, item) => total * 60 + item, 0);
}

export async function POST(request: Request) {
  try {
    const body = await readBody(request);
    const profileUrl = requiredString(body, "profileUrl");
    const apiKey = requiredString(body, "apiKey");
    const page = Math.min(100, Math.max(1, Number(body.page) || 1));
    const uid = extractUid(profileUrl);
    if (!uid) {
      return fail({
        service: "B站主页",
        reason: "没有识别出 UP 主 UID",
        suggestion: "请粘贴形如 https://space.bilibili.com/123456 的主页地址，也可以直接填写数字 UID。",
      });
    }

    const requested = await tikhubGet("fetch_user_post_videos", apiKey, { uid, pn: String(page), ps: "30", order: "pubdate" });
    if (requested.error) return requested.error;
    const payload = requested.payload!;
    const rows = findArrayByKey(payload.data, "vlist")
      ?? findArrayByKey(payload.data, "list")
      ?? (Array.isArray(payload.data) ? payload.data : []);

    const items = rows.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const row = entry as Record<string, unknown>;
      const aid = String(row.aid ?? row.id ?? "").replace(/^av/i, "");
      const bvid = String(row.bvid ?? row.bv_id ?? "");
      if (!aid && !bvid) return [];
      return [{
        id: bvid || `av${aid}`,
        aid,
        bvid,
        title: cleanTitle(row.title),
        description: String(row.description ?? row.desc ?? "").trim(),
        cover: String(row.pic ?? row.cover ?? "").replace(/^\/\//, "https://"),
        duration: parseDuration(row.length ?? row.duration),
        publishedAt: Number(row.created ?? row.pubdate ?? row.created_at) || 0,
        views: Number(row.play ?? row.view ?? 0) || 0,
      }];
    });

    if (!items.length) {
      return fail({
        service: "TikHub B站主页接口",
        reason: page === 1 ? "接口返回成功，但没有找到公开视频" : "已经没有更多公开视频",
        suggestion: "检查 UID 是否正确，或确认该 UP 主主页可以公开访问。",
      }, 404);
    }

    const pageInfo = findObjectWithKey(payload.data, "count");
    const total = Number(pageInfo?.count ?? 0) || 0;
    const pageSize = Number(pageInfo?.ps ?? 30) || 30;
    return json({
      uid,
      page,
      total,
      hasMore: total ? page * pageSize < total : items.length >= pageSize,
      items,
    });
  } catch (error) {
    return fail({ service: "TikHub B站主页接口", reason: error instanceof Error ? error.message : "读取主页失败" }, 400);
  }
}
