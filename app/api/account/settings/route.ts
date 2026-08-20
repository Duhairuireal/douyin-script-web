import { env } from "cloudflare:workers";
import { chatGPTSignInPath, getChatGPTUser } from "../../../chatgpt-auth";
import { decryptSettings, encryptSettings } from "../_crypto";

type RuntimeEnv = {
  DB?: D1Database;
  KEY_ENCRYPTION_SECRET?: string;
};

const runtime = env as unknown as RuntimeEnv;

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS user_api_settings (
  user_id TEXT PRIMARY KEY NOT NULL,
  encrypted_payload TEXT NOT NULL,
  iv TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;

const STRING_FIELDS = [
  "tikhubKey",
  "asrKey",
  "asrResourceId",
  "openRouterKey",
  "deepseekKey",
  "customName",
  "customBase",
  "customKey",
  "customModel",
] as const;

function requireRuntime() {
  if (!runtime.DB) throw new Error("账号存储数据库尚未配置");
  if (!runtime.KEY_ENCRYPTION_SECRET) throw new Error("API Key 加密服务尚未配置");
  return { db: runtime.DB, secret: runtime.KEY_ENCRYPTION_SECRET };
}

async function ensureTable(db: D1Database) {
  await db.prepare(CREATE_TABLE).run();
}

function cleanSettings(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("设置内容格式不正确");
  const input = value as Record<string, unknown>;
  const settings: Record<string, string> = {};
  for (const field of STRING_FIELDS) {
    const fieldValue = input[field];
    if (typeof fieldValue !== "string") throw new Error(`设置字段 ${field} 格式不正确`);
    settings[field] = fieldValue.trim().slice(0, field.includes("Key") || field === "asrKey" ? 1000 : 500);
  }
  const preset = String(input.summaryPreset ?? "openrouter-free");
  if (!["openrouter-free", "deepseek-flash", "deepseek-pro", "custom"].includes(preset)) throw new Error("总结模型设置不正确");
  settings.summaryPreset = preset;
  const thinking = String(input.deepseekThinking ?? "high");
  if (!["disabled", "high", "max"].includes(thinking)) throw new Error("思考强度设置不正确");
  settings.deepseekThinking = thinking;
  return settings;
}

function unauthorized() {
  return Response.json({
    authenticated: false,
    loginUrl: chatGPTSignInPath("/"),
  }, { status: 401, headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return unauthorized();
  try {
    const { db, secret } = requireRuntime();
    await ensureTable(db);
    const row = await db.prepare(
      "SELECT encrypted_payload, iv, updated_at FROM user_api_settings WHERE user_id = ?",
    ).bind(user.userId).first<{ encrypted_payload: string; iv: string; updated_at: string }>();
    const settings = row ? await decryptSettings(row.encrypted_payload, row.iv, secret) : null;
    return Response.json({
      authenticated: true,
      user: { displayName: user.displayName, email: user.email },
      settings,
      updatedAt: row?.updated_at ?? null,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "读取账号设置失败" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return unauthorized();
  try {
    const body = await request.json() as Record<string, unknown>;
    const settings = cleanSettings(body.settings);
    const { db, secret } = requireRuntime();
    await ensureTable(db);
    const encrypted = await encryptSettings(settings, secret);
    await db.prepare(`INSERT INTO user_api_settings (user_id, encrypted_payload, iv, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        encrypted_payload = excluded.encrypted_payload,
        iv = excluded.iv,
        updated_at = CURRENT_TIMESTAMP`)
      .bind(user.userId, encrypted.encryptedPayload, encrypted.iv)
      .run();
    return Response.json({ saved: true, updatedAt: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "保存账号设置失败" }, { status: 400 });
  }
}

export async function DELETE() {
  const user = await getChatGPTUser();
  if (!user) return unauthorized();
  try {
    const { db } = requireRuntime();
    await ensureTable(db);
    await db.prepare("DELETE FROM user_api_settings WHERE user_id = ?").bind(user.userId).run();
    return Response.json({ deleted: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "删除账号设置失败" }, { status: 500 });
  }
}
