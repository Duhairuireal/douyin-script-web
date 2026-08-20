import { sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const userApiSettings = sqliteTable("user_api_settings", {
  userId: text("user_id").primaryKey(),
  encryptedPayload: text("encrypted_payload").notNull(),
  iv: text("iv").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
