import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";

type RuntimeEnv = { DB?: D1Database };
const runtime = env as unknown as RuntimeEnv;

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS transcript_documents (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  original_transcript TEXT NOT NULL,
  working_content TEXT NOT NULL,
  initial_summary TEXT NOT NULL DEFAULT '',
  last_prompt TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

const CREATE_INDEX = `CREATE INDEX IF NOT EXISTS idx_transcript_documents_user_updated
  ON transcript_documents(user_id, updated_at DESC)`;

type DocumentRow = {
  id: string;
  platform: string;
  source_id: string;
  source_url: string;
  title: string;
  author: string;
  original_transcript: string;
  working_content: string;
  initial_summary: string;
  last_prompt: string;
  model: string;
  method: string;
  created_at: number;
  updated_at: number;
};

function database() {
  if (!runtime.DB) throw new Error("历史记录数据库尚未配置");
  return runtime.DB;
}

async function ensureTable(db: D1Database) {
  await db.batch([db.prepare(CREATE_TABLE), db.prepare(CREATE_INDEX)]);
}

function cleanString(value: unknown, name: string, max: number, required = false) {
  const result = typeof value === "string" ? value.trim() : "";
  if (required && !result) throw new Error(`${name}不能为空`);
  if (result.length > max) throw new Error(`${name}过长`);
  return result;
}

function documentFromRow(row: DocumentRow) {
  return {
    id: row.id,
    platform: row.platform,
    sourceId: row.source_id,
    sourceUrl: row.source_url,
    title: row.title,
    author: row.author,
    originalTranscript: row.original_transcript,
    workingContent: row.working_content,
    initialSummary: row.initial_summary,
    lastPrompt: row.last_prompt,
    model: row.model,
    method: row.method,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function unauthorized() {
  return Response.json({ error: "请先登录后再同步历史记录" }, { status: 401, headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return unauthorized();
  try {
    const db = database();
    await ensureTable(db);
    const result = await db.prepare(`SELECT id, platform, source_id, source_url, title, author,
      original_transcript, working_content, initial_summary, last_prompt, model, method, created_at, updated_at
      FROM transcript_documents WHERE user_id = ? ORDER BY updated_at DESC LIMIT 200`)
      .bind(user.userId).all<DocumentRow>();
    return Response.json({ documents: (result.results ?? []).map(documentFromRow) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "读取历史记录失败" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return unauthorized();
  try {
    const body = await request.json() as Record<string, unknown>;
    const input = body.document && typeof body.document === "object" ? body.document as Record<string, unknown> : {};
    const id = cleanString(input.id, "文稿 ID", 100, true);
    const platform = cleanString(input.platform, "平台", 20, true);
    if (!["douyin", "bilibili", "manual"].includes(platform)) throw new Error("不支持的内容平台");
    const originalTranscript = cleanString(input.originalTranscript, "原始转写", 450_000, true);
    const workingContent = cleanString(input.workingContent, "工作稿", 450_000, true);
    const createdAt = Number(input.createdAt) || Date.now();
    const updatedAt = Number(input.updatedAt) || createdAt;
    const db = database();
    await ensureTable(db);
    const owner = await db.prepare("SELECT user_id FROM transcript_documents WHERE id = ?").bind(id).first<{ user_id: string }>();
    if (owner && owner.user_id !== user.userId) return Response.json({ error: "无权修改这份文稿" }, { status: 403 });
    await db.prepare(`INSERT INTO transcript_documents (
      id, user_id, platform, source_id, source_url, title, author, original_transcript,
      working_content, initial_summary, last_prompt, model, method, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      platform = excluded.platform,
      source_id = excluded.source_id,
      source_url = excluded.source_url,
      title = excluded.title,
      author = excluded.author,
      original_transcript = excluded.original_transcript,
      working_content = excluded.working_content,
      initial_summary = excluded.initial_summary,
      last_prompt = excluded.last_prompt,
      model = excluded.model,
      method = excluded.method,
      updated_at = excluded.updated_at`)
      .bind(
        id, user.userId, platform,
        cleanString(input.sourceId, "来源 ID", 160), cleanString(input.sourceUrl, "来源链接", 2000),
        cleanString(input.title, "标题", 500, true), cleanString(input.author, "作者", 300, true),
        originalTranscript, workingContent, cleanString(input.initialSummary, "初始成稿", 450_000),
        cleanString(input.lastPrompt, "提示词", 2000), cleanString(input.model, "模型", 200),
        cleanString(input.method, "转写方式", 100), createdAt, updatedAt,
      ).run();
    return Response.json({ saved: true, id }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "保存历史记录失败" }, { status: 400 });
  }
}

export async function PUT(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return unauthorized();
  try {
    const body = await request.json() as Record<string, unknown>;
    const id = cleanString(body.id, "文稿 ID", 100, true);
    const workingContent = cleanString(body.workingContent, "工作稿", 450_000, true);
    const lastPrompt = cleanString(body.lastPrompt, "提示词", 2000);
    const updatedAt = Number(body.updatedAt) || Date.now();
    const db = database();
    await ensureTable(db);
    const result = await db.prepare(`UPDATE transcript_documents
      SET working_content = ?, last_prompt = ?, updated_at = ?
      WHERE id = ? AND user_id = ?`)
      .bind(workingContent, lastPrompt, updatedAt, id, user.userId).run();
    if (!result.meta.changes) return Response.json({ error: "没有找到这份文稿" }, { status: 404 });
    return Response.json({ saved: true, updatedAt }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "更新文稿失败" }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return unauthorized();
  try {
    const body = await request.json() as Record<string, unknown>;
    const id = cleanString(body.id, "文稿 ID", 100, true);
    const db = database();
    await ensureTable(db);
    await db.prepare("DELETE FROM transcript_documents WHERE id = ? AND user_id = ?").bind(id, user.userId).run();
    return Response.json({ deleted: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "删除文稿失败" }, { status: 400 });
  }
}
