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

test("server-renders the account entry screen", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>视频成稿｜抖音与B站转文字、AI 总结<\/title>/i);
  assert.match(html, /一个内测账号，保存你的创作进度/);
  assert.match(html, /账号和密码/);
  assert.match(html, /正在检查登录状态/);
  assert.match(html, /正在为你读取账号与已保存的连接设置/);
  assert.match(html, /正式开放用户前会升级云端账号系统/);
});

test("keeps platform workflows and secrets separated", async () => {
  const [page, importer, historyWorkspace, historyClient, localAccount, projectNotes, historyRoute, schema, douyinRoute, biliProfile, biliTranscript, visionRoute, accountRoute, cryptoHelper, hosting] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/BilibiliImporter.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/HistoryWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/history-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/local-account.ts", import.meta.url), "utf8"),
    readFile(new URL("../PROJECT_NOTES.md", import.meta.url), "utf8"),
    readFile(new URL("../app/api/history/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/tikhub/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/bilibili/profile/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/bilibili/transcript/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/vision/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/account/settings/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/account/_crypto.ts", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /contentType === "image"/);
  assert.match(importer, /fetch_video_subtitle|\/api\/bilibili\/transcript/);
  assert.match(importer, /indexedDB\.open/);
  assert.match(page, /HistoryWorkspace/);
  assert.match(page, /saveHistoryDocument/);
  assert.match(historyWorkspace, /原始转写/);
  assert.match(historyWorkspace, /让 AI 改一下/);
  assert.match(historyWorkspace, /updateHistoryDocument/);
  assert.match(historyClient, /migrateLegacyBilibiliHistory/);
  assert.match(historyClient, /localOwnerId/);
  assert.match(localAccount, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(localAccount, /passwordHash/);
  assert.doesNotMatch(localAccount, /passwordPlaintext/);
  assert.match(localAccount, /douyin-script-web-settings-v2:local:/);
  assert.match(projectNotes, /Supabase Auth/);
  assert.match(projectNotes, /开始收费/);
  assert.match(historyRoute, /WHERE id = \? AND user_id = \?/);
  assert.match(schema, /transcriptDocuments/);
  assert.match(douyinRoute, /aweme_type\) === 68/);
  assert.match(biliProfile, /fetch_user_post_videos/);
  assert.match(biliTranscript, /fetch_video_playurl/);
  assert.match(visionRoute, /image_url/);
  assert.match(accountRoute, /getChatGPTUser/);
  assert.match(accountRoute, /ON CONFLICT\(user_id\) DO UPDATE/);
  assert.match(cryptoHelper, /AES-GCM/);
  assert.match(hosting, /"d1": "DB"/);
  assert.match(page, /video-script-local-only/);
  assert.match(page, /function SecretField/);
  assert.match(page, />更换<\/button>/);
  assert.match(page, /旧 Key 尚未保存更改/);
  assert.doesNotMatch(`${page}\n${importer}`, /tk_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{16,}/);

  await access(new URL("../app/api/bilibili/media/route.ts", import.meta.url));
});
