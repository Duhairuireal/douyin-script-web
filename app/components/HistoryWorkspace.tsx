"use client";

import { useEffect, useMemo, useState } from "react";
import {
  deleteHistoryDocument,
  HISTORY_CHANGED_EVENT,
  type HistoryDocument,
  loadHistoryDocuments,
  updateHistoryDocument,
} from "../lib/history-client";

type SummaryConnection = {
  apiKey: string;
  baseUrl: string;
  model: string;
  displayName: string;
  providerName: string;
  thinking: "disabled" | "high" | "max";
};

type Props = {
  summaryConnection: SummaryConnection;
  signedIn: boolean;
  onOpenSettings: () => void;
  onCreateNew: () => void;
};

const REWRITE_PROMPTS = [
  ["整理结构", "重新梳理逻辑，增加清晰的小标题和段落，但不删减重要信息"],
  ["精简口语", "删除重复、语气词和口语赘词，保持原意，整理成简洁流畅的书面表达"],
  ["公众号", "改写成适合微信公众号发布的文章，保留原观点，加入清晰的小标题"],
  ["小红书", "改写成适合小红书发布的笔记，短段落、有节奏、重点清晰，不编造事实"],
] as const;

function platformLabel(platform: HistoryDocument["platform"]) {
  return platform === "douyin" ? "抖音" : platform === "bilibili" ? "B站" : "导入";
}

function formatTime(value: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function safeFileName(value: string) {
  return (value || "历史文稿").replace(/[<>:"/\\|?*]/g, "_").slice(0, 70);
}

function downloadText(name: string, content: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function rewriteWithAi(connection: SummaryConnection, document: HistoryDocument, content: string, prompt: string) {
  const response = await fetch("/api/summarize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiKey: connection.apiKey,
      baseUrl: connection.baseUrl,
      model: connection.model,
      providerName: connection.providerName,
      thinking: connection.thinking,
      prompt,
      source: { title: document.title, author: document.author },
      transcript: content,
    }),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const detail = payload.error && typeof payload.error === "object" ? payload.error as Record<string, unknown> : {};
    throw new Error(String(detail.reason ?? payload.error ?? "AI 改写失败"));
  }
  if (typeof payload.summary !== "string" || !payload.summary.trim()) throw new Error("AI 没有返回改写内容");
  return payload.summary.trim();
}

export default function HistoryWorkspace({ summaryConnection, signedIn, onOpenSettings, onCreateNew }: Props) {
  const [documents, setDocuments] = useState<HistoryDocument[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState<"working" | "original">("working");
  const [draft, setDraft] = useState("");
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [beforeAi, setBeforeAi] = useState("");

  useEffect(() => {
    let active = true;
    const load = () => {
      setLoading(true);
      void loadHistoryDocuments().then((rows) => {
        if (!active) return;
        setDocuments(rows);
        const target = rows[0];
        setSelectedId(target?.id ?? "");
        setDraft(target?.workingContent ?? "");
        setPrompt(target?.lastPrompt ?? "");
        setLoading(false);
      }).catch((caught) => {
        if (!active) return;
        setError(caught instanceof Error ? caught.message : "读取历史记录失败");
        setLoading(false);
      });
    };
    queueMicrotask(load);
    const changed = () => { load(); };
    window.addEventListener(HISTORY_CHANGED_EVENT, changed);
    return () => {
      active = false;
      window.removeEventListener(HISTORY_CHANGED_EVENT, changed);
    };
  }, []);

  const selected = documents.find((row) => row.id === selectedId) ?? null;
  const filtered = useMemo(() => {
    const clean = query.trim().toLowerCase();
    if (!clean) return documents;
    return documents.filter((row) => `${row.title} ${row.author} ${row.originalTranscript}`.toLowerCase().includes(clean));
  }, [documents, query]);

  const selectDocument = (document: HistoryDocument) => {
    setSelectedId(document.id);
    setDraft(document.workingContent);
    setPrompt(document.lastPrompt);
    setActiveTab("working");
    setMessage("");
    setError("");
    setBeforeAi("");
  };

  const dirty = Boolean(selected && draft !== selected.workingContent);

  const saveDraft = async () => {
    if (!selected || !draft.trim()) return;
    setSaving(true);
    setError("");
    try {
      const updated = await updateHistoryDocument(selected.id, draft.trim(), prompt.trim());
      setDocuments((rows) => [updated, ...rows.filter((row) => row.id !== updated.id)]);
      setSelectedId(updated.id);
      setMessage(signedIn ? "修改已保存到账号" : "修改已保存在这台电脑");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const runRewrite = async () => {
    if (!selected) return;
    if (!summaryConnection.apiKey || !summaryConnection.baseUrl || !summaryConnection.model) {
      setError("当前总结模型还没有配置好，请先填写 API Key 和模型信息。");
      onOpenSettings();
      return;
    }
    if (!prompt.trim()) {
      setError("请先写一句改写要求，或选择下面的快捷提示词。");
      return;
    }
    if (!draft.trim()) {
      setError("工作稿是空的，无法改写。");
      return;
    }
    setRewriting(true);
    setError("");
    setMessage("");
    setBeforeAi(draft);
    try {
      const rewritten = await rewriteWithAi(summaryConnection, selected, draft, prompt.trim());
      setDraft(rewritten);
      setActiveTab("working");
      setMessage("AI 已完成改写，确认内容后点击保存修改");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "AI 改写失败");
    } finally {
      setRewriting(false);
    }
  };

  const removeDocument = async () => {
    if (!selected || !window.confirm(`确定删除《${selected.title}》吗？原始转写和工作稿都会删除。`)) return;
    await deleteHistoryDocument(selected.id);
    setDocuments((rows) => rows.filter((row) => row.id !== selected.id));
    setSelectedId("");
  };

  const copyCurrent = async () => {
    if (!selected) return;
    await navigator.clipboard.writeText(activeTab === "original" ? selected.originalTranscript : draft);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <section className="history-shell">
      <header className="history-titlebar">
        <div>
          <p className="eyebrow">你的文稿库</p>
          <h2>转写过的内容，都能回来继续改</h2>
          <p>原始转写永久保留，工作稿可以手动编辑，也可以交给 AI 按新提示词继续改写。</p>
        </div>
        <span className="history-sync-pill"><i />{signedIn ? "已同步到账号" : "仅保存在这台电脑"}</span>
      </header>

      <div className="history-layout">
        <aside className="history-sidebar">
          <div className="history-search">
            <span>⌕</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、作者或原文" aria-label="搜索历史文稿" />
          </div>
          <div className="history-list-head"><b>{filtered.length} 份文稿</b><span>最近修改优先</span></div>
          <div className="history-list">
            {loading && <div className="history-empty compact">正在读取历史记录…</div>}
            {!loading && filtered.map((row) => (
              <button className={row.id === selectedId ? "active" : ""} key={row.id} onClick={() => selectDocument(row)}>
                <span className={`platform-mark ${row.platform}`}>{platformLabel(row.platform).slice(0, 1)}</span>
                <span className="history-row-copy">
                  <b>{row.title}</b>
                  <small>{row.author} · {formatTime(row.updatedAt)}</small>
                  <em>{row.originalTranscript.length.toLocaleString()} 字 · {row.method || platformLabel(row.platform)}</em>
                </span>
              </button>
            ))}
            {!loading && !filtered.length && (
              <div className="history-empty compact">{query ? "没有找到匹配文稿" : "还没有历史文稿"}</div>
            )}
          </div>
        </aside>

        <div className="history-editor">
          {!selected ? (
            <div className="history-empty">
              <span>稿</span>
              <h3>这里会保存每一次转写</h3>
              <p>完成一条抖音视频、图文或 B站作品后，原文与 AI 成稿都会自动出现在这里。</p>
              <button className="primary-button" onClick={onCreateNew}>开始第一份文稿 <span>→</span></button>
            </div>
          ) : (
            <>
              <header className="document-head">
                <div>
                  <span className="document-source">{platformLabel(selected.platform)} · {selected.method || "文字导入"}</span>
                  <h3>{selected.title}</h3>
                  <p>作者：{selected.author} · {selected.model || "未记录模型"}</p>
                </div>
                <div className="document-actions">
                  <button onClick={copyCurrent}>{copied ? "已复制" : "复制"}</button>
                  <button onClick={() => downloadText(`${safeFileName(selected.title)}-${activeTab === "original" ? "原始转写" : "工作稿"}.txt`, activeTab === "original" ? selected.originalTranscript : draft)}>下载</button>
                  <button className="danger-text" onClick={removeDocument}>删除</button>
                </div>
              </header>

              <div className="document-tabs">
                <button className={activeTab === "working" ? "active" : ""} onClick={() => setActiveTab("working")}>可编辑工作稿 <i>{dirty ? "未保存" : "已保存"}</i></button>
                <button className={activeTab === "original" ? "active" : ""} onClick={() => setActiveTab("original")}>原始转写 <i>只读底稿</i></button>
              </div>

              {activeTab === "working" ? (
                <div className="document-workspace">
                  <textarea className="document-textarea" value={draft} onChange={(event) => { setDraft(event.target.value); setMessage(""); }} aria-label="可编辑工作稿" />
                  <div className="document-savebar">
                    <span>{draft.length.toLocaleString()} 个字符{message ? ` · ${message}` : ""}</span>
                    <div>
                      {beforeAi && draft !== beforeAi && <button className="secondary-button" onClick={() => { setDraft(beforeAi); setBeforeAi(""); setMessage("已撤销本次 AI 改写"); }}>撤销 AI 改写</button>}
                      <button className="primary-button" onClick={saveDraft} disabled={saving || !dirty}>{saving ? "保存中" : dirty ? "保存修改" : "已保存"}</button>
                    </div>
                  </div>

                  <div className="rewrite-panel">
                    <div className="rewrite-heading">
                      <div><span>AI</span><p><b>继续改写这份文稿</b><small>当前使用 {summaryConnection.displayName}</small></p></div>
                      <em>{prompt.length}/2000</em>
                    </div>
                    <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={2000} placeholder="例如：保留观点，删掉重复内容，改成一篇 800 字的公众号文章……" aria-label="AI 改写提示词" />
                    <div className="rewrite-footer">
                      <div>{REWRITE_PROMPTS.map(([label, value]) => <button key={label} onClick={() => setPrompt(value)}>{label}</button>)}</div>
                      <button className="ai-rewrite-button" onClick={runRewrite} disabled={rewriting}>{rewriting ? "AI 正在改写…" : "让 AI 改一下 →"}</button>
                    </div>
                    {error && <p className="history-error">{error}</p>}
                  </div>
                </div>
              ) : (
                <div className="original-document">
                  <div><b>这是识别完成时保存的原文</b><span>不会被手动编辑或 AI 改写覆盖</span></div>
                  <article>{selected.originalTranscript}</article>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
