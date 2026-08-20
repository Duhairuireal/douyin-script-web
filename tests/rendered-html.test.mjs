import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the video transcript studio", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>视频成稿｜抖音与B站转文字、AI 总结<\/title>/i);
  assert.match(html, /抖音单条/);
  assert.match(html, /B站主页/);
  assert.match(html, /视频 \/ 图文自动识别/);
  assert.match(html, /已有文稿/);
});

test("keeps platform workflows and secrets separated", async () => {
  const [page, importer, douyinRoute, biliProfile, biliTranscript, visionRoute] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/BilibiliImporter.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/tikhub/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/bilibili/profile/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/bilibili/transcript/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/vision/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /contentType === "image"/);
  assert.match(importer, /fetch_video_subtitle|\/api\/bilibili\/transcript/);
  assert.match(importer, /indexedDB\.open/);
  assert.match(douyinRoute, /aweme_type\) === 68/);
  assert.match(biliProfile, /fetch_user_post_videos/);
  assert.match(biliTranscript, /fetch_video_playurl/);
  assert.match(visionRoute, /image_url/);
  assert.doesNotMatch(`${page}\n${importer}`, /tk_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{16,}/);

  await access(new URL("../app/api/bilibili/media/route.ts", import.meta.url));
});
