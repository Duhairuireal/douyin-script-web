import { fail, json, readBody, requiredString } from "../../_shared";
import { findArrayByKey, findObjectWithKey, firstHttps, tikhubGet } from "../_shared";

function pickCid(payload: Record<string, unknown>) {
  const pages = findArrayByKey(payload.data, "pages") ?? (Array.isArray(payload.data) ? payload.data : undefined);
  if (pages?.length && pages[0] && typeof pages[0] === "object") {
    const cid = (pages[0] as Record<string, unknown>).cid;
    if (cid !== undefined) return String(cid);
  }
  const row = findObjectWithKey(payload.data, "cid");
  return row?.cid === undefined ? "" : String(row.cid);
}

function subtitleUrl(payload: Record<string, unknown>) {
  const subtitles = findArrayByKey(payload.data, "subtitles") ?? findArrayByKey(payload.data, "subtitle");
  if (!subtitles?.length) return "";
  const rows = subtitles.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
  const preferred = rows.find((row) => /zh|中文|ai-zh/i.test(String(row.lan ?? row.lan_doc ?? row.lang ?? ""))) ?? rows[0];
  return firstHttps(preferred);
}

async function readSubtitle(url: string) {
  const response = await fetch(url, { headers: { Accept: "application/json,text/plain,*/*" } });
  if (!response.ok) return "";
  const payload = await response.json().catch(() => null) as unknown;
  if (!payload || typeof payload !== "object") return "";
  const body = (payload as Record<string, unknown>).body;
  if (!Array.isArray(body)) return "";
  return body.map((item) => item && typeof item === "object" ? (item as Record<string, unknown>).content : "")
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .join("\n")
    .trim();
}

function audioUrl(payload: Record<string, unknown>) {
  const audio = findArrayByKey(payload.data, "audio");
  if (audio?.length) return firstHttps(audio);
  const durl = findArrayByKey(payload.data, "durl");
  if (durl?.length) return firstHttps(durl);
  return "";
}

export async function POST(request: Request) {
  try {
    const body = await readBody(request);
    const apiKey = requiredString(body, "apiKey");
    const aid = requiredString(body, "aid").replace(/^av/i, "");
    const bvid = requiredString(body, "bvid");

    const partsResult = await tikhubGet("fetch_video_parts", apiKey, { bv_id: bvid });
    if (partsResult.error) return partsResult.error;
    const cid = pickCid(partsResult.payload!);
    if (!cid) return fail({ service: "TikHub B站分P接口", reason: "没有读取到视频 CID" }, 502);

    const subtitleResult = await tikhubGet("fetch_video_subtitle", apiKey, { a_id: aid, c_id: cid });
    if (!subtitleResult.error) {
      const url = subtitleUrl(subtitleResult.payload!);
      if (url) {
        const transcript = await readSubtitle(url);
        if (transcript) return json({ transcript, method: "subtitle", cid });
      }
    }

    const playResult = await tikhubGet("fetch_video_playurl", apiKey, { bv_id: bvid, cid });
    if (playResult.error) return playResult.error;
    const mediaUrl = audioUrl(playResult.payload!);
    if (!mediaUrl) {
      return fail({
        service: "TikHub B站播放地址接口",
        reason: "这条视频没有公开字幕，也没有取得可识别的音频地址",
        suggestion: "视频可能需要登录、属于会员内容，或播放地址已经受限。",
      }, 502);
    }
    const proxyUrl = new URL("/api/bilibili/media", request.url);
    proxyUrl.searchParams.set("url", mediaUrl);
    return json({ mediaUrl: proxyUrl.toString(), method: "asr", cid });
  } catch (error) {
    return fail({ service: "B站文稿提取", reason: error instanceof Error ? error.message : "提取文稿失败" }, 400);
  }
}
