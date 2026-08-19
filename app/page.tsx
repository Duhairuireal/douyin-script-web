"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type InputMode = "link" | "text";
type Stage = "idle" | "resolving" | "transcribing" | "summarizing" | "done" | "error";
type ResultTab = "summary" | "transcript";

type Settings = {
  tikhubKey: string;
  asrKey: string;
  asrResourceId: string;
  summaryBase: string;
  summaryKey: string;
  summaryModel: string;
};

type ModelOption = {
  id: string;
  name: string;
  provider: string;
  note: string;
  mark: string;
  tags: string[];
};

type Source = {
  awemeId: string;
  title: string;
  author: string;
  mediaUrl?: string;
};

type GenerationResult = {
  source: Source;
  transcript: string;
  summary: string;
  model: string;
};

type DisplayError = {
  service: string;
  status?: string;
  reason: string;
  suggestion?: string;
  requestId?: string;
};

const STORAGE_KEY = "douyin-script-web-settings-v1";

const BUILTIN_MODELS: ModelOption[] = [
  {
    id: "deepseek-chat",
    name: "DeepSeek V3",
    provider: "DeepSeek",
    note: "速度快，适合日常内容整理",
    mark: "D",
    tags: ["文本", "快速"],
  },
  {
    id: "deepseek-reasoner",
    name: "DeepSeek R1",
    provider: "DeepSeek",
    note: "推理更深入，适合复杂内容",
    mark: "R",
    tags: ["文本", "推理"],
  },
];

const DEFAULT_SETTINGS: Settings = {
  tikhubKey: "",
  asrKey: "",
  asrResourceId: "volc.seedasr.auc",
  summaryBase: "https://api.deepseek.com",
  summaryKey: "",
  summaryModel: "deepseek-chat",
};

const STAGE_INDEX: Record<Stage, number> = {
  idle: 0,
  resolving: 1,
  transcribing: 2,
  summarizing: 3,
  done: 4,
  error: 0,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function readError(value: unknown): DisplayError {
  if (value && typeof value === "object" && "service" in value && "reason" in value) {
    return value as DisplayError;
  }
  if (value instanceof Error) {
    return { service: "网站处理流程", reason: value.message };
  }
  return { service: "网站处理流程", reason: "发生了未知错误" };
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

function safeFileName(value: string) {
  return (value || "抖音成稿").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 70);
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

export default function Home() {
  const [inputMode, setInputMode] = useState<InputMode>("link");
  const [input, setInput] = useState("");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [draftSettings, setDraftSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [stage, setStage] = useState<Stage>("idle");
  const [pollCount, setPollCount] = useState(0);
  const [result, setResult] = useState<GenerationResult | null>(null);
  const [resultTab, setResultTab] = useState<ResultTab>("summary");
  const [error, setError] = useState<DisplayError | null>(null);
  const [copied, setCopied] = useState(false);
  const modelPickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } as Settings;
        setSettings(parsed);
        setDraftSettings(parsed);
      }
    } catch {
      // Keep safe defaults if browser storage is unavailable or malformed.
    }
  }, []);

  useEffect(() => {
    const closePicker = (event: PointerEvent) => {
      if (!modelPickerRef.current?.contains(event.target as Node)) setModelOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setModelOpen(false);
        setSettingsOpen(false);
      }
    };
    document.addEventListener("pointerdown", closePicker);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closePicker);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  const selectedModel = useMemo<ModelOption>(() => {
    return (
      BUILTIN_MODELS.find((item) => item.id === settings.summaryModel) ?? {
        id: settings.summaryModel || "custom-model",
        name: settings.summaryModel || "自定义模型",
        provider: "自定义接口",
        note: "OpenAI 兼容模型",
        mark: "C",
        tags: ["自定义"],
      }
    );
  }, [settings.summaryModel]);

  const visibleModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    if (!query) return BUILTIN_MODELS;
    return BUILTIN_MODELS.filter((item) => `${item.name} ${item.id} ${item.note}`.toLowerCase().includes(query));
  }, [modelSearch]);

  const busy = stage === "resolving" || stage === "transcribing" || stage === "summarizing";
  const stageIndex = STAGE_INDEX[stage];
  const progress = stage === "resolving" ? 16 : stage === "transcribing" ? Math.min(72, 30 + pollCount * 4) : stage === "summarizing" ? 86 : stage === "done" ? 100 : 0;

  const persistSettings = (next: Settings) => {
    setSettings(next);
    setDraftSettings(next);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  };

  const selectModel = (modelId: string) => {
    persistSettings({ ...settings, summaryModel: modelId });
    setModelOpen(false);
    setModelSearch("");
  };

  const openSettings = () => {
    setDraftSettings(settings);
    setSettingsOpen(true);
    setModelOpen(false);
  };

  const saveSettings = () => {
    persistSettings({
      ...draftSettings,
      tikhubKey: draftSettings.tikhubKey.trim(),
      asrKey: draftSettings.asrKey.trim(),
      asrResourceId: draftSettings.asrResourceId.trim() || DEFAULT_SETTINGS.asrResourceId,
      summaryBase: draftSettings.summaryBase.trim().replace(/\/+$/, ""),
      summaryKey: draftSettings.summaryKey.trim(),
      summaryModel: draftSettings.summaryModel.trim() || DEFAULT_SETTINGS.summaryModel,
    });
    setSettingsOpen(false);
  };

  const ensureReady = () => {
    const missing: string[] = [];
    if (inputMode === "link" && !settings.tikhubKey) missing.push("TikHub API Key");
    if (inputMode === "link" && !settings.asrKey) missing.push("火山 ASR API Key");
    if (!settings.summaryKey) missing.push("DeepSeek API Key");
    if (!settings.summaryBase || !settings.summaryModel) missing.push("总结接口和模型");
    if (missing.length) {
      setError({
        service: "连接设置",
        reason: `还没有填写：${missing.join("、")}`,
        suggestion: "打开连接设置，填好后再生成。密钥只保存在当前浏览器。",
      });
      setStage("error");
      openSettings();
      return false;
    }
    return true;
  };

  const handleGenerate = async () => {
    const cleanInput = input.trim();
    if (!cleanInput) {
      setError({ service: "输入内容", reason: inputMode === "link" ? "请先粘贴抖音分享链接" : "请先粘贴已有文字稿" });
      setStage("error");
      return;
    }
    if (inputMode === "text" && cleanInput.length < 20) {
      setError({ service: "输入内容", reason: "文字稿太短，请至少粘贴 20 个字" });
      setStage("error");
      return;
    }
    if (!ensureReady()) return;

    setError(null);
    setResult(null);
    setPollCount(0);
    setCopied(false);

    try {
      let source: Source;
      let transcript: string;

      if (inputMode === "link") {
        setStage("resolving");
        const resolved = await apiPost<Source>("/api/tikhub", {
          shareText: cleanInput,
          apiKey: settings.tikhubKey,
        });
        source = resolved;

        setStage("transcribing");
        const submitted = await apiPost<{ state: "pending" | "done"; taskId: string; logId?: string; transcript?: string }>(
          "/api/asr/submit",
          {
            mediaUrl: resolved.mediaUrl,
            apiKey: settings.asrKey,
            resourceId: settings.asrResourceId,
          },
        );

        transcript = submitted.transcript ?? "";
        if (submitted.state !== "done") {
          for (let attempt = 1; attempt <= 75; attempt += 1) {
            setPollCount(attempt);
            await sleep(4000);
            const queried = await apiPost<{ state: "pending" | "done"; transcript?: string }>("/api/asr/query", {
              taskId: submitted.taskId,
              logId: submitted.logId,
              apiKey: settings.asrKey,
              resourceId: settings.asrResourceId,
            });
            if (queried.state === "done") {
              transcript = queried.transcript ?? "";
              break;
            }
          }
        }
        if (!transcript) {
          throw {
            service: "火山豆包 ASR",
            reason: "等待 5 分钟后仍未取得文字稿",
            suggestion: "稍后重试，或检查这条视频是否可以公开访问。",
          } satisfies DisplayError;
        }
      } else {
        source = { awemeId: "manual", title: "粘贴的文字稿", author: "手动导入" };
        transcript = cleanInput;
      }

      setStage("summarizing");
      const summarized = await apiPost<{ summary: string }>("/api/summarize", {
        apiKey: settings.summaryKey,
        baseUrl: settings.summaryBase,
        model: settings.summaryModel,
        source,
        transcript,
      });

      setResult({ source, transcript, summary: summarized.summary, model: settings.summaryModel });
      setResultTab("summary");
      setStage("done");
    } catch (caught) {
      setError(readError(caught));
      setStage("error");
    }
  };

  const copyResult = async () => {
    if (!result) return;
    const content = resultTab === "summary" ? result.summary : result.transcript;
    await navigator.clipboard.writeText(content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const markdownResult = result
    ? `# ${result.source.title}\n\n作者：${result.source.author}\n总结模型：${result.model}\n\n## AI 摘要\n\n${result.summary}\n\n## 完整文字稿\n\n${result.transcript}\n`
    : "";

  return (
    <main className="app-shell">
      <aside className="side-rail" aria-label="主要导航">
        <div className="brand-mark" title="抖音成稿">稿</div>
        <nav>
          <button className="rail-button active" aria-label="新建成稿" title="新建成稿">＋</button>
        </nav>
        <button className="rail-button rail-settings" onClick={openSettings} aria-label="连接设置" title="连接设置">⚙</button>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">抖音成稿</p>
            <h1>把一条视频，变成一份能用的文字</h1>
            <p className="hero-note">不保存视频，只生成完整文稿与重点摘要。</p>
          </div>

          <div className="model-picker" ref={modelPickerRef}>
            <button
              className="model-trigger"
              onClick={() => setModelOpen((open) => !open)}
              aria-haspopup="listbox"
              aria-expanded={modelOpen}
            >
              <span className="model-avatar">{selectedModel.mark}</span>
              <span className="model-trigger-copy">
                <strong>{selectedModel.name}</strong>
                <small>{selectedModel.provider} · 总结模型</small>
              </span>
              <span className={`chevron ${modelOpen ? "open" : ""}`}>⌄</span>
            </button>

            {modelOpen && (
              <div className="model-menu" role="dialog" aria-label="选择总结模型">
                <div className="model-menu-head">
                  <span>选择总结模型</span>
                  <span className="model-count">{BUILTIN_MODELS.length} 个常用</span>
                </div>
                <label className="model-search">
                  <span>⌕</span>
                  <input
                    value={modelSearch}
                    onChange={(event) => setModelSearch(event.target.value)}
                    placeholder="搜索模型"
                    autoFocus
                  />
                </label>
                <p className="model-group">DEEPSEEK</p>
                <div role="listbox">
                  {visibleModels.map((item) => (
                    <button
                      className={`model-row ${selectedModel.id === item.id ? "selected" : ""}`}
                      key={item.id}
                      onClick={() => selectModel(item.id)}
                      role="option"
                      aria-selected={selectedModel.id === item.id}
                    >
                      <span className="model-avatar small">{item.mark}</span>
                      <span className="model-row-copy">
                        <strong>{item.name}</strong>
                        <small>{item.note}</small>
                      </span>
                      <span className="model-row-tags">
                        {item.tags.map((tag) => <i key={tag}>{tag}</i>)}
                      </span>
                      {selectedModel.id === item.id && <span className="model-check">✓</span>}
                    </button>
                  ))}
                  {!visibleModels.length && <div className="model-empty">没有找到匹配模型</div>}
                </div>
                {!BUILTIN_MODELS.some((item) => item.id === settings.summaryModel) && (
                  <button className="model-row selected custom-row" onClick={() => selectModel(settings.summaryModel)}>
                    <span className="model-avatar small custom">C</span>
                    <span className="model-row-copy"><strong>{settings.summaryModel}</strong><small>当前自定义模型</small></span>
                    <span className="model-check">✓</span>
                  </button>
                )}
                <button className="model-manage" onClick={openSettings}>⚙ 管理模型与 API</button>
              </div>
            )}
          </div>
        </header>

        <div className="content-grid">
          <section className="input-card">
            <div className="input-card-top">
              <div className="card-heading">
                <span className="step-number">01</span>
                <div>
                  <h2>{inputMode === "link" ? "粘贴视频链接" : "粘贴已有文字稿"}</h2>
                  <p>{inputMode === "link" ? "支持抖音分享口令或完整链接" : "跳过语音识别，直接进行 AI 总结"}</p>
                </div>
              </div>
              <div className="mode-switch" aria-label="输入方式">
                <button className={inputMode === "link" ? "active" : ""} onClick={() => setInputMode("link")}>视频链接</button>
                <button className={inputMode === "text" ? "active" : ""} onClick={() => setInputMode("text")}>已有文稿</button>
              </div>
            </div>
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              aria-label={inputMode === "link" ? "抖音视频链接" : "已有文字稿"}
              placeholder={
                inputMode === "link"
                  ? "把抖音分享内容粘贴到这里…\n例如：https://v.douyin.com/xxxx/"
                  : "把抖音或豆包已经生成的文字稿粘贴到这里…"
              }
              disabled={busy}
            />
            <div className="input-footer">
              <span className="privacy-note"><i /> {inputMode === "link" ? "视频由火山服务器读取，不在网站保存" : `${input.length} 个字符`}</span>
              <button className="primary-button" onClick={handleGenerate} disabled={busy}>
                {busy ? "正在处理" : "生成文字稿"} <span>{busy ? "···" : "→"}</span>
              </button>
            </div>
          </section>

          <aside className={`result-preview ${busy ? "processing" : ""}`}>
            <div className="preview-heading">
              <span className="step-number">02</span>
              {stage === "idle" && <span className="ready-pill">准备就绪</span>}
              {stage === "done" && <span className="ready-pill done">已经完成</span>}
            </div>

            {stage === "idle" && (
              <>
                <h2>一次生成，直接可用</h2>
                <div className="result-items">
                  <div><b>全文</b><span>完整转写与智能分段</span></div>
                  <div><b>摘要</b><span>核心观点与关键信息</span></div>
                  <div><b>文件</b><span>TXT 与 Markdown 下载</span></div>
                </div>
              </>
            )}

            {busy && (
              <>
                <h2>正在把视频整理成文字</h2>
                <div className="progress-track"><i style={{ width: `${progress}%` }} /></div>
                <div className="process-steps">
                  {[
                    [1, "读取视频", "取得标题和播放地址"],
                    [2, "语音转写", pollCount ? `正在查询识别结果 · ${pollCount}` : "豆包 Seed-ASR 2.0"],
                    [3, "整理重点", selectedModel.name],
                  ].map(([index, title, note]) => (
                    <div className={stageIndex === index ? "current" : stageIndex > Number(index) ? "finished" : ""} key={String(title)}>
                      <i>{stageIndex > Number(index) ? "✓" : index}</i>
                      <span><b>{title}</b><small>{note}</small></span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {stage === "done" && result && (
              <>
                <h2>文字与重点都准备好了</h2>
                <div className="done-stats">
                  <div><b>{result.transcript.length.toLocaleString()}</b><span>文稿字符</span></div>
                  <div><b>2</b><span>下载格式</span></div>
                </div>
                <button className="secondary-button" onClick={() => {
                  setInput("");
                  setResult(null);
                  setStage("idle");
                }}>处理下一条</button>
              </>
            )}

            {stage === "error" && error && (
              <div className="error-panel">
                <span className="error-mark">!</span>
                <h2>这一步没有成功</h2>
                <dl>
                  <div><dt>出错位置</dt><dd>{error.service}</dd></div>
                  {error.status && <div><dt>状态</dt><dd>{error.status}</dd></div>}
                  <div><dt>具体原因</dt><dd>{error.reason}</dd></div>
                  {error.suggestion && <div><dt>怎么处理</dt><dd>{error.suggestion}</dd></div>}
                  {error.requestId && <div><dt>请求 ID</dt><dd className="mono">{error.requestId}</dd></div>}
                </dl>
                <button className="secondary-button" onClick={handleGenerate}>重新尝试</button>
              </div>
            )}

            <div className="pipeline-note">
              <span>TikHub</span><i />
              <span>豆包 ASR</span><i />
              <span>{selectedModel.name}</span>
            </div>
          </aside>
        </div>

        {result && stage === "done" && (
          <section className="result-workspace">
            <div className="result-toolbar">
              <div>
                <p className="result-kicker">{result.source.author}</p>
                <h2>{result.source.title}</h2>
              </div>
              <div className="result-actions">
                <button onClick={copyResult}>{copied ? "已复制" : "复制"}</button>
                <button onClick={() => downloadText(`${safeFileName(result.source.title)}.txt`, result.transcript)}>下载 TXT</button>
                <button onClick={() => downloadText(`${safeFileName(result.source.title)}.md`, markdownResult, "text/markdown;charset=utf-8")}>下载 Markdown</button>
              </div>
            </div>
            <div className="result-tabs" role="tablist">
              <button className={resultTab === "summary" ? "active" : ""} onClick={() => setResultTab("summary")} role="tab">AI 摘要</button>
              <button className={resultTab === "transcript" ? "active" : ""} onClick={() => setResultTab("transcript")} role="tab">完整文字稿</button>
            </div>
            <article className={resultTab === "summary" ? "summary-content" : "transcript-content"}>
              {resultTab === "summary" ? result.summary : result.transcript}
            </article>
          </section>
        )}
      </section>

      {settingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSettingsOpen(false);
        }}>
          <section className="settings-modal" role="dialog" aria-modal="true" aria-label="连接设置">
            <header>
              <div>
                <p className="eyebrow">连接设置</p>
                <h2>连接三个服务</h2>
                <span>密钥只保存在这个浏览器，不写入网站服务器。</span>
              </div>
              <button className="modal-close" onClick={() => setSettingsOpen(false)} aria-label="关闭">×</button>
            </header>

            <div className="settings-body">
              <div className="provider-section">
                <div className="provider-title"><i>1</i><span><b>TikHub</b><small>读取抖音作品信息与视频地址</small></span><em className={draftSettings.tikhubKey ? "ok" : ""}>{draftSettings.tikhubKey ? "已填写" : "待填写"}</em></div>
                <label><span>API Key</span><input type={showKeys ? "text" : "password"} value={draftSettings.tikhubKey} onChange={(event) => setDraftSettings({ ...draftSettings, tikhubKey: event.target.value })} placeholder="tk_..." autoComplete="off" /></label>
              </div>

              <div className="provider-section">
                <div className="provider-title"><i>2</i><span><b>火山豆包 ASR</b><small>录音文件识别 2.0，生成完整文稿</small></span><em className={draftSettings.asrKey ? "ok" : ""}>{draftSettings.asrKey ? "已填写" : "待填写"}</em></div>
                <div className="field-grid">
                  <label><span>ASR API Key</span><input type={showKeys ? "text" : "password"} value={draftSettings.asrKey} onChange={(event) => setDraftSettings({ ...draftSettings, asrKey: event.target.value })} placeholder="火山语音控制台的 API Key" autoComplete="off" /></label>
                  <label><span>资源 ID</span><input value={draftSettings.asrResourceId} onChange={(event) => setDraftSettings({ ...draftSettings, asrResourceId: event.target.value })} /></label>
                </div>
              </div>

              <div className="provider-section">
                <div className="provider-title"><i>3</i><span><b>DeepSeek</b><small>总结重点，支持 OpenAI 兼容接口</small></span><em className={draftSettings.summaryKey ? "ok" : ""}>{draftSettings.summaryKey ? "已填写" : "待填写"}</em></div>
                <label><span>API 地址</span><input value={draftSettings.summaryBase} onChange={(event) => setDraftSettings({ ...draftSettings, summaryBase: event.target.value })} placeholder="https://api.deepseek.com" /></label>
                <div className="field-grid">
                  <label><span>API Key</span><input type={showKeys ? "text" : "password"} value={draftSettings.summaryKey} onChange={(event) => setDraftSettings({ ...draftSettings, summaryKey: event.target.value })} placeholder="sk-..." autoComplete="off" /></label>
                  <label><span>模型名称</span><input value={draftSettings.summaryModel} onChange={(event) => setDraftSettings({ ...draftSettings, summaryModel: event.target.value })} placeholder="deepseek-chat" /></label>
                </div>
              </div>
            </div>

            <footer>
              <label className="show-key-toggle"><input type="checkbox" checked={showKeys} onChange={(event) => setShowKeys(event.target.checked)} /> 显示密钥</label>
              <div><button className="cancel-button" onClick={() => setSettingsOpen(false)}>取消</button><button className="primary-button" onClick={saveSettings}>保存设置 <span>✓</span></button></div>
            </footer>
          </section>
        </div>
      )}
    </main>
  );
}
