import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const userApiSettings = sqliteTable("user_api_settings", {
  userId: text("user_id").primaryKey(),
  encryptedPayload: text("encrypted_payload").notNull(),
  iv: text("iv").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const transcriptDocuments = sqliteTable(
  "transcript_documents",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    platform: text("platform").notNull(),
    sourceId: text("source_id").notNull(),
    sourceUrl: text("source_url").notNull().default(""),
    title: text("title").notNull(),
    author: text("author").notNull(),
    originalTranscript: text("original_transcript").notNull(),
    workingContent: text("working_content").notNull(),
    initialSummary: text("initial_summary").notNull().default(""),
    lastPrompt: text("last_prompt").notNull().default(""),
    model: text("model").notNull().default(""),
    method: text("method").notNull().default(""),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("idx_transcript_documents_user_updated").on(table.userId, table.updatedAt)],
);
