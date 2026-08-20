"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { saveHistoryDocument } from "../lib/history-client";

type DisplayError = {
  service: string;
  status?: string;
  reason: string;
  suggestion?: string;
  requestId?: string;
};

type SummaryConnection = {
  apiKey: string;
  baseUrl: string;
  model: string;
  displayName: string;
  providerName: string;
  thinking: "disabled" | "high" | "max";
};

type BiliVideo = {
  id: string;
  aid: string;
  bvid: string;
  title: string;
  description: string;
  cover: string;
  duration: number;
  publishedAt: number;
  views: number;
};

type ItemState = "waiting" | "reading" | "transcribing" | "summarizing" | "done" | "error";

type ArchiveResult = {
  id: string;
  title: string;
  author: string;
  transcript: string;
  summary: string;
  model: string;
  method: "subtitle" | "asr";
  savedAt: number;
};

type Props = {
  tikhubKey: string;
  asrKey: string;
  asrResourceId: string;
  generationPrompt: string;
  onGenerationPromptChange: (value: string) => void;
  summaryConnection: SummaryConnection;
  onOpenSettings: () => void;
};

const DB_NAME = "video-script-studio";
const DB_VERSION = 2;
const STORE_NAME = "bilibili-results";
const HISTORY_STORE_NAME = "history-documents";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function readError(value: unknown): DisplayError {
  if (value && typeof value === "object" && "service" in value && "reason" in value) return value as DisplayError;
  if (value instanceof Error) return { service: "B站批量处理", reason: value.message };
  return { service: "B站批量处理", reason: "发生了未知错误" };
}

async function apiPost<T>(url: string, payload: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const detail = (data.error ?? {}) as Record<string, unknown>;
    throw {
      service: String(detail.service ?? "接口请求"),
      status: detail.status ? String(detail.status) : `HTTP ${response.status}`,
      reason: String(detail.reason ?? "服务器没有返回具体原因"),
      suggestion: detail.suggestion ? String(detail.suggestion) : undefined,
      requestId: detail.requestId ? String(detail.requestId) : undefined,
    } satisfies DisplayError;
  }
  return data as T;
}

function openArchiveDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      if (!request.result.objectStoreNames.contains(HISTORY_STORE_NAME)) request.result.createObjectStore(HISTORY_STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function listArchive() {
  const db = await openArchiveDb();
  return new Promise<ArchiveResult[]>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve((request.result as ArchiveResult[]).sort((a, b) => b.savedAt - a.savedAt));
    request.onerror = () => reject(request.error);
  }).finally(() => db.close());
}

async function saveArchive(result: ArchiveResult) {
  const db = await openArchiveDb();
  return new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(result);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  }).finally(() => db.close());
}

function safeFileName(value: string) {
  return (value || "B站成稿").replace(/[<>:"/\\|?*]/g, "_").slice(0, 70);
}

function downloadText(name: string, content: string, type = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function formatDuration(seconds: number) {
  if (!seconds) return "时长未知";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}` : `${minutes}:${String(rest).padStart(2, "0")}`;
}

function formatDate(timestamp: number) {
  if (!timestamp) return "日期未知";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(timestamp * 1000));
}

function resultMarkdown(result: ArchiveResult) {
  return `# ${result.title}\n\n作者：${result.author}\n文稿来源：${result.method === "subtitle" ? "B站字幕" : "豆包 ASR"}\n生成模型：${result.model}\n\n## AI 成稿\n\n${result.summary}\n\n## 完整文字稿\n\n${result.transcript}\n`;
}

export default function BilibiliImporter(props: Props) {
  const [profileUrl, setProfileUrl] = useState("");
  const [uid, setUid] = useState("");
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [items, setItems] = useState<BiliVideo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [states, setStates] = useState<Record<string, ItemState>>({});
  const [errors, setErrors] = useState<Record<string, DisplayError>>({});
  const [archive, setArchive] = useState<ArchiveResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [currentTitle, setCurrentTitle] = useState("");
  const [error, setError] = useState<DisplayError | null>(null);
  const stopRef = useRef(false);

  useEffect(() => {
    listArchive().then(setArchive).catch(() => undefined);
  }, []);

  const selectedItems = useMemo(() => items.filter((item) => selected.has(item.id)), [items, selected]);
  const completedCount = selectedItems.filter((item) => states[item.id] === "done").length;

  const readPage = async (nextPage: number, append: boolean) => {
    if (!props.tikhubKey) {
      setError({ service: "连接设置", reason: "还没有填写 TikHub API Key", suggestion: "打开连接设置，填好后再读取主页。" });
      props.onOpenSettings();
      return;
    }
    if (!append && !profileUrl.trim()) {
      setError({ service: "B站主页", reason: "请先粘贴 UP 主主页链接或数字 UID" });
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await apiPost<{ uid: string; page: number; total: number; hasMore: boolean; items: BiliVideo[] }>("/api/bilibili/profile", {
        profileUrl: append ? uid : profileUrl.trim(),
        apiKey: props.tikhubKey,
        page: nextPage,
      });
      setUid(result.uid);
      setPage(result.page);
      setTotal(result.total);
      setHasMore(result.hasMore);
      setItems((current) => append ? [...current, ...result.items.filter((item) => !current.some((old) => old.id === item.id))] : result.items);
      if (!append) {
        setSelected(new Set());
        setStates({});
        setErrors({});
      }
    } catch (caught) {
      setError(readError(caught));
    } finally {
      setLoading(false);
    }
  };

  const pollAsr = async (mediaUrl: string) => {
    if (!props.asrKey) {
      throw {
        service: "火山豆包 ASR",
        reason: "这条 B站视频没有公开字幕，需要语音识别，但还没有填写 ASR API Key",
        suggestion: "在连接设置里填写火山豆包 ASR Key；有公开字幕的视频不消耗 ASR。",
      } satisfies DisplayError;
    }
    const submitted = await apiPost<{ state: "pending" | "done"; taskId: string; logId?: string; transcript?: string }>("/api/asr/submit", {
      mediaUrl,
      apiKey: props.asrKey,
      resourceId: props.asrResourceId,
    });
    if (submitted.transcript) return submitted.transcript;
    for (let attempt = 0; attempt < 75; attempt += 1) {
      if (stopRef.current) throw new Error("已停止批量处理");
      await sleep(4000);
      const queried = await apiPost<{ state: "pending" | "done"; transcript?: string }>("/api/asr/query", {
        taskId: submitted.taskId,
        logId: submitted.logId,
        apiKey: props.asrKey,
        resourceId: props.asrResourceId,
      });
      if (queried.state === "done" && queried.transcript) return queried.transcript;
    }
    throw new Error("等待 5 分钟后仍未取得文字稿");
  };

  const startBatch = async () => {
    if (!selectedItems.length) {
      setError({ service: "B站批量处理", reason: "请至少勾选一条视频" });
      return;
    }
    if (!props.tikhubKey || !props.summaryConnection.apiKey) {
      setError({ service: "连接设置", reason: "TikHub 或当前总结模型的 API Key 还没有填写", suggestion: "打开连接设置，填好后再开始。" });
      props.onOpenSettings();
      return;
    }
    stopRef.current = false;
    setProcessing(true);
    setError(null);
    for (const item of selectedItems) {
      if (stopRef.current) break;
      setCurrentTitle(item.title);
      setStates((current) => ({ ...current, [item.id]: "reading" }));
      setErrors((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
      try {
        const extracted = await apiPost<{ transcript?: string; mediaUrl?: string; method: "subtitle" | "asr" }>("/api/bilibili/transcript", {
          apiKey: props.tikhubKey,
          aid: item.aid,
          bvid: item.bvid,
        });
        let transcript = extracted.transcript ?? "";
        if (!transcript && extracted.mediaUrl) {
          setStates((current) => ({ ...current, [item.id]: "transcribing" }));
          transcript = await pollAsr(extracted.mediaUrl);
        }
        if (!transcript) throw new Error("没有取得视频文字稿");

        setStates((current) => ({ ...current, [item.id]: "summarizing" }));
        const summarized = await apiPost<{ summary: string; resolvedModel?: string }>("/api/summarize", {
          apiKey: props.summaryConnection.apiKey,
          baseUrl: props.summaryConnection.baseUrl,
          model: props.summaryConnection.model,
          providerName: props.summaryConnection.providerName,
          thinking: props.summaryConnection.thinking,
          prompt: props.generationPrompt.trim(),
          source: { title: item.title, author: `B站 UP主 ${uid}`, bvid: item.bvid },
          transcript,
        });
        const saved: ArchiveResult = {
          id: item.id,
          title: item.title,
          author: `B站 UP主 ${uid}`,
          transcript,
          summary: summarized.summary,
          model: summarized.resolvedModel && props.summaryConnection.model === "openrouter/free"
            ? `${props.summaryConnection.displayName} · ${summarized.resolvedModel}`
            : props.summaryConnection.displayName,
          method: extracted.method,
          savedAt: Date.now(),
        };
        await saveArchive(saved);
        await saveHistoryDocument({
          platform: "bilibili",
          sourceId: item.id,
          sourceUrl: `https://www.bilibili.com/video/${item.bvid}`,
          title: item.title,
          author: `B站 UP主 ${uid}`,
          originalTranscript: transcript,
          workingContent: summarized.summary,
          initialSummary: summarized.summary,
          lastPrompt: props.generationPrompt.trim(),
          model: saved.model,
          method: extracted.method === "subtitle" ? "B站字幕" : "豆包 ASR",
        }).catch(() => undefined);
        setArchive((current) => [saved, ...current.filter((row) => row.id !== saved.id)]);
        setStates((current) => ({ ...current, [item.id]: "done" }));
      } catch (caught) {
        const detail = readError(caught);
        if (stopRef.current) break;
        setErrors((current) => ({ ...current, [item.id]: detail }));
        setStates((current) => ({ ...current, [item.id]: "error" }));
      }
    }
    setCurrentTitle("");
    setProcessing(false);
  };

  const downloadBatch = () => {
    const ids = new Set(selectedItems.map((item) => item.id));
    const rows = archive.filter((result) => ids.has(result.id));
    if (!rows.length) return;
    const content = rows.slice().reverse().map(resultMarkdown).join("\n\n---\n\n");
    downloadText(`B站批量成稿-${uid || "archive"}.md`, content, "text/markdown;charset=utf-8");
  };

  const statusLabel = (state?: ItemState) => ({
    waiting: "等待处理",
    reading: "检查字幕",
    transcribing: "语音识别",
    summarizing: "AI 成稿",
    done: "已保存",
    error: "失败",
  }[state ?? "waiting"]);

  return (
    <section className="batch-card">
      <header className="batch-head">
        <div>
          <p className="eyebrow">BILIBILI · 批量工作区</p>
          <h2>读取一个 UP 主，再选择需要保存的作品</h2>
          <p>优先使用 B站公开字幕；没有字幕时才调用豆包 ASR。完成结果自动进入历史文稿库。</p>
        </div>
        <span className="local-save-pill">已完成 {archive.length} 条</span>
      </header>

      <div className="profile-reader">
        <input
          value={profileUrl}
          onChange={(event) => setProfileUrl(event.target.value)}
          placeholder="粘贴 https://space.bilibili.com/123456，或直接填写 UID"
          disabled={loading || processing}
          aria-label="B站UP主主页"
        />
        <button className="primary-button" onClick={() => readPage(1, false)} disabled={loading || processing}>
          {loading && !items.length ? "正在读取" : "读取主页"} <span>→</span>
        </button>
      </div>

      <div className="batch-prompt">
        <div><b>本批生成提示词</b><span>{props.generationPrompt.length}/2000</span></div>
        <textarea
          value={props.generationPrompt}
          onChange={(event) => props.onGenerationPromptChange(event.target.value)}
          placeholder="例如：把每条视频整理成公众号文章，保留原作者观点并增加小标题……"
          maxLength={2000}
          disabled={processing}
        />
        <div>
          <button onClick={() => props.onGenerationPromptChange("整理成公众号文章，保留原作者的观点和语气")} disabled={processing}>公众号文章</button>
          <button onClick={() => props.onGenerationPromptChange("生成小红书笔记，使用短段落和清晰的小标题")} disabled={processing}>小红书笔记</button>
          <button onClick={() => props.onGenerationPromptChange("只提炼核心要点，不扩写，不添加原文没有的信息")} disabled={processing}>精简要点</button>
          {props.generationPrompt && <button onClick={() => props.onGenerationPromptChange("")} disabled={processing}>清空</button>}
        </div>
      </div>

      {error && (
        <div className="inline-error">
          <b>{error.service}</b>
          <span>{error.status ? `${error.status} · ` : ""}{error.reason}</span>
          {error.suggestion && <small>{error.suggestion}</small>}
        </div>
      )}

      {items.length > 0 && (
        <>
          <div className="batch-toolbar">
            <div>
              <b>已读取 {items.length}{total ? ` / ${total}` : ""} 条</b>
              <span>已选择 {selected.size} 条 · 预计至少 {selected.size * 2} 次 TikHub 请求</span>
            </div>
            <div>
              <button onClick={() => setSelected(new Set(items.map((item) => item.id)))} disabled={processing}>全选已加载</button>
              <button onClick={() => setSelected(new Set())} disabled={processing}>清空选择</button>
              {hasMore && <button onClick={() => readPage(page + 1, true)} disabled={loading || processing}>{loading ? "读取中" : "加载更多"}</button>}
            </div>
          </div>

          <div className="video-select-list">
            {items.map((item) => {
              const state = states[item.id];
              const checked = selected.has(item.id);
              return (
                <label className={`video-select-row ${checked ? "selected" : ""}`} key={item.id}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={processing}
                    onChange={() => setSelected((current) => {
                      const next = new Set(current);
                      if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
                      return next;
                    })}
                  />
                  {/* Remote covers come from Bilibili and do not need site-side optimization. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {item.cover ? <img src={item.cover} alt="" /> : <span className="cover-placeholder">B</span>}
                  <span className="video-row-copy">
                    <b>{item.title}</b>
                    <small>{item.bvid} · {formatDate(item.publishedAt)} · {formatDuration(item.duration)}{item.views ? ` · ${item.views.toLocaleString()} 播放` : ""}</small>
                    {state === "error" && errors[item.id] && <em>{errors[item.id].reason}</em>}
                  </span>
                  <i className={`item-state ${state ?? "waiting"}`}>{statusLabel(state)}</i>
                </label>
              );
            })}
          </div>

          <div className="batch-runbar">
            <div>
              <b>{processing ? `正在处理：${currentTitle}` : selected.size ? `准备处理 ${selected.size} 条` : "请先选择作品"}</b>
              <span>{processing ? `${completedCount}/${selected.size} 已完成，可随时停止` : "每次只处理一条，避免触发接口并发限制"}</span>
            </div>
            <div>
              {completedCount > 0 && <button className="secondary-button" onClick={downloadBatch}>下载本批 Markdown</button>}
              {processing
                ? <button className="stop-button" onClick={() => { stopRef.current = true; }}>完成当前步骤后停止</button>
                : <button className="primary-button" onClick={startBatch}>开始批量生成 <span>→</span></button>}
            </div>
          </div>
        </>
      )}

      {archive.length > 0 && (
        <div className="archive-section">
          <div className="archive-heading"><b>最近完成</b><span>完整原文和可编辑工作稿可在“历史文稿”中继续处理</span></div>
          <div className="archive-list">
            {archive.slice(0, 12).map((result) => (
              <details key={`${result.id}-${result.savedAt}`}>
                <summary>
                  <span><b>{result.title}</b><small>{result.method === "subtitle" ? "B站字幕" : "豆包 ASR"} · {new Date(result.savedAt).toLocaleString("zh-CN")}</small></span>
                  <i>查看成稿</i>
                </summary>
                <div className="archive-content">
                  <pre>{result.summary}</pre>
                  <button onClick={() => downloadText(`${safeFileName(result.title)}.md`, resultMarkdown(result), "text/markdown;charset=utf-8")}>下载 Markdown</button>
                </div>
              </details>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
