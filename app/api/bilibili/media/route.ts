import { fail } from "../../_shared";

const ALLOWED_HOSTS = [".bilivideo.com", ".bilivideo.cn", ".akamaized.net", ".bilibili.com"];

export async function GET(request: Request) {
  try {
    const source = new URL(request.url).searchParams.get("url") ?? "";
    const parsed = new URL(source);
    if (parsed.protocol !== "https:" || !ALLOWED_HOSTS.some((suffix) => parsed.hostname.toLowerCase().endsWith(suffix))) {
      return fail({ service: "B站音频转发", reason: "音频地址不在允许的 B站 CDN 范围内" }, 400);
    }
    const upstream = await fetch(parsed, {
      headers: {
        Referer: "https://www.bilibili.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
      },
    });
    if (!upstream.ok || !upstream.body) {
      return fail({ service: "B站音频转发", status: `HTTP ${upstream.status}`, reason: "B站音频地址无法读取，地址可能已经过期" }, 502);
    }
    const headers = new Headers();
    headers.set("Content-Type", upstream.headers.get("Content-Type") || "audio/mp4");
    const length = upstream.headers.get("Content-Length");
    if (length) headers.set("Content-Length", length);
    headers.set("Cache-Control", "private, max-age=300");
    headers.set("Accept-Ranges", "bytes");
    return new Response(upstream.body, { status: 200, headers });
  } catch (error) {
    return fail({ service: "B站音频转发", reason: error instanceof Error ? error.message : "音频转发失败" }, 400);
  }
}
