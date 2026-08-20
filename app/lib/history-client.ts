"use client";

export type HistoryPlatform = "douyin" | "bilibili" | "manual";

export type HistoryDocument = {
  id: string;
  platform: HistoryPlatform;
  sourceId: string;
  sourceUrl: string;
  title: string;
  author: string;
  originalTranscript: string;
  workingContent: string;
  initialSummary: string;
  lastPrompt: string;
  model: string;
  method: string;
  createdAt: number;
  updatedAt: number;
};

export type NewHistoryDocument = Omit<HistoryDocument, "id" | "createdAt" | "updatedAt"> & {
  id?: string;
  createdAt?: number;
  updatedAt?: number;
};

const DB_NAME = "video-script-studio";
const DB_VERSION = 2;
const HISTORY_STORE = "history-documents";
const LEGACY_BILIBILI_STORE = "bilibili-results";
export const HISTORY_CHANGED_EVENT = "video-script-history-changed";

type LegacyBilibiliResult = {
  id: string;
  title: string;
  author: string;
  transcript: string;
  summary: string;
  model: string;
  method: "subtitle" | "asr";
  savedAt: number;
};

function openDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(LEGACY_BILIBILI_STORE)) {
        request.result.createObjectStore(LEGACY_BILIBILI_STORE, { keyPath: "id" });
      }
      if (!request.result.objectStoreNames.contains(HISTORY_STORE)) {
        request.result.createObjectStore(HISTORY_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function localPut(document: HistoryDocument) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const request = db.transaction(HISTORY_STORE, "readwrite").objectStore(HISTORY_STORE).put(document);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  }).finally(() => db.close());
}

async function localDelete(id: string) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const request = db.transaction(HISTORY_STORE, "readwrite").objectStore(HISTORY_STORE).delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  }).finally(() => db.close());
}

export async function listLocalHistory() {
  const db = await openDb();
  return new Promise<HistoryDocument[]>((resolve, reject) => {
    const request = db.transaction(HISTORY_STORE, "readonly").objectStore(HISTORY_STORE).getAll();
    request.onsuccess = () => resolve((request.result as HistoryDocument[]).sort((a, b) => b.updatedAt - a.updatedAt));
    request.onerror = () => reject(request.error);
  }).finally(() => db.close());
}

export async function migrateLegacyBilibiliHistory() {
  const db = await openDb();
  const legacy = await new Promise<LegacyBilibiliResult[]>((resolve, reject) => {
    const request = db.transaction(LEGACY_BILIBILI_STORE, "readonly").objectStore(LEGACY_BILIBILI_STORE).getAll();
    request.onsuccess = () => resolve(request.result as LegacyBilibiliResult[]);
    request.onerror = () => reject(request.error);
  }).finally(() => db.close());

  const current = await listLocalHistory();
  const migratedSources = new Set(current.filter((row) => row.platform === "bilibili").map((row) => row.sourceId));
  const additions: HistoryDocument[] = [];
  for (const row of legacy) {
    if (migratedSources.has(row.id)) continue;
    const document: HistoryDocument = {
      id: crypto.randomUUID(),
      platform: "bilibili",
      sourceId: row.id,
      sourceUrl: "",
      title: row.title,
      author: row.author,
      originalTranscript: row.transcript,
      workingContent: row.summary || row.transcript,
      initialSummary: row.summary,
      lastPrompt: "",
      model: row.model,
      method: row.method === "subtitle" ? "B站字幕" : "豆包 ASR",
      createdAt: row.savedAt,
      updatedAt: row.savedAt,
    };
    await localPut(document);
    additions.push(document);
  }
  return additions;
}

function notifyHistoryChanged() {
  window.dispatchEvent(new CustomEvent(HISTORY_CHANGED_EVENT));
}

async function cloudWrite(method: "POST" | "PUT" | "DELETE", payload: Record<string, unknown>) {
  const response = await fetch("/api/history", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (response.status === 401) return null;
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data.error ?? "历史记录同步失败"));
  return data;
}

export async function saveHistoryDocument(input: NewHistoryDocument) {
  const now = Date.now();
  const document: HistoryDocument = {
    ...input,
    id: input.id || crypto.randomUUID(),
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now,
  };
  await localPut(document);
  try {
    await cloudWrite("POST", { document });
  } catch {
    // The local copy remains available when cloud synchronization is temporarily unavailable.
  }
  notifyHistoryChanged();
  return document;
}

export async function loadHistoryDocuments() {
  const migrated = await migrateLegacyBilibiliHistory();
  let local = await listLocalHistory();
  const response = await fetch("/api/history", { headers: { Accept: "application/json" } });
  if (response.status === 401) return local;
  if (!response.ok) return local;

  const payload = await response.json() as { documents?: HistoryDocument[] };
  const cloud = Array.isArray(payload.documents) ? payload.documents : [];
  const cloudById = new Map(cloud.map((row) => [row.id, row]));
  const pending = new Map<string, HistoryDocument>();
  for (const row of [...migrated, ...local]) {
    const cloudRow = cloudById.get(row.id);
    if (!cloudRow || row.updatedAt > cloudRow.updatedAt) pending.set(row.id, row);
  }
  await Promise.allSettled([...pending.values()].slice(0, 100).map((document) => cloudWrite("POST", { document })));

  const merged = new Map<string, HistoryDocument>();
  for (const row of local) merged.set(row.id, row);
  for (const row of cloud) {
    const cached = merged.get(row.id);
    if (!cached || row.updatedAt >= cached.updatedAt) {
      merged.set(row.id, row);
      await localPut(row);
    }
  }
  local = [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  return local;
}

export async function updateHistoryDocument(id: string, workingContent: string, lastPrompt: string) {
  const local = await listLocalHistory();
  const current = local.find((row) => row.id === id);
  if (!current) throw new Error("没有找到这份文稿");
  const updated: HistoryDocument = { ...current, workingContent, lastPrompt, updatedAt: Date.now() };
  await localPut(updated);
  try {
    await cloudWrite("PUT", { id, workingContent, lastPrompt, updatedAt: updated.updatedAt });
  } catch {
    // Keep edits locally and retry synchronization the next time history is loaded.
  }
  notifyHistoryChanged();
  return updated;
}

export async function deleteHistoryDocument(id: string) {
  await localDelete(id);
  try {
    await cloudWrite("DELETE", { id });
  } catch {
    // Local deletion still succeeds if account storage is unavailable.
  }
  notifyHistoryChanged();
}
