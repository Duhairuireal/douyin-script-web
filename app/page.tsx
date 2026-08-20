"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import BilibiliImporter from "./components/BilibiliImporter";
import HistoryWorkspace from "./components/HistoryWorkspace";
import { saveHistoryDocument } from "./lib/history-client";

type InputMode = "link" | "bilibili" | "text";
type WorkspaceView = "create" | "history";
type Stage = "idle" | "resolving" | "transcribing" | "summarizing" | "done" | "error";
type ResultTab = "summary" | "transcript";
type SummaryPreset = "openrouter-free" | "deepseek-flash" | "deepseek-pro" | "custom";
type ThinkingLevel = "disabled" | "high" | "max";
type AccountStatus = "loading" | "anonymous" | "authenticated" | "error";
type SyncState = "idle" | "saving" | "saved" | "error";

type AccountUser = {
  displayName: string;
  email: string;
};

type Settings = {
  tikhubKey: string;
  asrKey: string;
  asrResourceId: string;
  summaryPreset: SummaryPreset;
  openRouterKey: string;
  deepseekKey: string;
  deepseekThinking: ThinkingLevel;
  customName: string;
  customBase: string;
  customKey: string;
  customModel: string;
};

type ModelOption = {
  id: SummaryPreset;
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
  contentType?: "video" | "image";
  mediaUrl?: string;
  images?: string[];
  textContent?: string;
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

type SummaryConnection = {
  apiKey: string;
  baseUrl: string;
  model: string;
  displayName: string;
  providerName: string;
  thinking: ThinkingLevel;
};

const STORAGE_KEY = "douyin-script-web-settings-v2";

const BUILTIN_MODELS: ModelOption[] = [
  {
    id: "openrouter-free",
    name: "免费总结",
    provider: "OpenRouter",
    note: "自动选择当前可用的免费模型",
    mark: "F",
    tags: ["免费", "默认"],
  },
  {
    id: "deepseek-flash",
    name: "DeepSeek V4 Flash",
    provider: "DeepSeek",
    note: "便宜快速，适合大多数视频总结",
    mark: "D",
    tags: ["快速", "推荐"],
  },
  {
    id: "deepseek-pro",
    name: "DeepSeek V4 Pro",
    provider: "DeepSeek",
    note: "复杂长文与高质量结构化总结",
    mark: "P",
    tags: ["高质量", "深度"],
  },
];

const DEFAULT_SETTINGS: Settings = {
  tikhubKey: "",
  asrKey: "",
  asrResourceId: "volc.seedasr.auc",
  summaryPreset: "openrouter-free",
  openRouterKey: "",
  deepseekKey: "",
  deepseekThinking: "high",
  customName: "我的模型",
  customBase: "",
  customKey: "",
  customModel: "",
};

const PROMPT_EXAMPLES = [
  "整理成公众号文章，保留原作者的观点和语气",
  "生成小红书笔记，使用短段落和清晰的小标题",
  "只提炼核心要点，不扩写，不添加原文没有的信息",
];

function getSummaryConnection(settings: Settings): SummaryConnection {
  if (settings.summaryPreset === "openrouter-free") {
    return {
      apiKey: settings.openRouterKey,
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openrouter/free",
      displayName: "免费总结",
      providerName: "OpenRouter 免费总结",
      thinking: "disabled",
    };
  }
  if (settings.summaryPreset === "deepseek-flash") {
    return {
      apiKey: settings.deepseekKey,
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      displayName: "DeepSeek V4 Flash",
      providerName: "DeepSeek V4 Flash",
      thinking: "disabled",
    };
  }
  if (settings.summaryPreset === "deepseek-pro") {
    return {
      apiKey: settings.deepseekKey,
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
      displayName: "DeepSeek V4 Pro",
      providerName: "DeepSeek V4 Pro",
      thinking: settings.deepseekThinking,
    };
  }
  return {
    apiKey: settings.customKey,
    baseUrl: settings.customBase,
    model: settings.customModel,
    displayName: settings.customName || settings.customModel || "自定义模型",
    providerName: settings.customName || "自定义总结接口",
    thinking: "disabled",
  };
}

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
  return (value || "抖音成稿").replace(/[<>:"/\\|?*]/g, "_").slice(0, 70);
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

function hasSavedKeys(settings: Settings) {
  return Boolean(settings.tikhubKey || settings.asrKey || settings.openRouterKey || settings.deepseekKey || settings.customKey);
}

function LoginGate({
  status,
  error,
  onContinueLocally,
  onRetry,
}: {
  status: AccountStatus;
  error: string;
  onContinueLocally: () => void;
  onRetry: () => void;
}) {
  return (
    <main className="login-shell">
      <section className="login-story">
        <div className="login-brand"><span>稿</span><b>视频成稿</b></div>
        <div className="login-copy">
          <p className="eyebrow">你的内容工作台</p>
          <h1>登录一次，常用的 Key 自动回来</h1>
          <p>抖音、B站、语音识别与总结模型的连接设置，都跟随你的账号安全保存。</p>
        </div>
        <div className="login-benefits">
          <div><i>01</i><span><b>自动恢复</b><small>换电脑或清理浏览器后，不必重新找 Key</small></span></div>
          <div><i>02</i><span><b>加密保存</b><small>密钥加密后写入账号数据库，不会进入公开代码</small></span></div>
          <div><i>03</i><span><b>仍可本机使用</b><small>暂不登录时，也可以只把设置留在当前浏览器</small></span></div>
        </div>
      </section>

      <section className="login-panel">
        <div className="login-card">
          <span className="login-card-mark">稿</span>
          <p className="eyebrow">欢迎回来</p>
          <h2>{status === "loading" ? "正在检查登录状态" : status === "error" ? "暂时无法连接账号" : "登录视频成稿"}</h2>
          <p>{status === "loading" ? "正在为你读取账号与已保存的连接设置……" : error || "使用 ChatGPT 账号登录，自动同步以前填写过的 API Key。"}</p>
          {status === "loading" ? (
            <div className="login-loading"><i /><span>正在连接</span></div>
          ) : (
            <>
              <a className="login-primary" href="/signin-with-chatgpt?return_to=%2F">使用 ChatGPT 登录 <span>→</span></a>
              {status === "error" && <button className="login-retry" onClick={onRetry}>重新检查</button>}
              <button className="login-local" onClick={onContinueLocally}>暂不登录，只在本机使用</button>
            </>
          )}
          <small className="login-privacy">登录只用于识别你的账号和保存设置，不会读取你的 ChatGPT 对话。</small>
        </div>
      </section>
    </main>
  );
}

export default function Home() {
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("create");
  const [inputMode, setInputMode] = useState<InputMode>("link");
  const [input, setInput] = useState("");
  const [generationPrompt, setGenerationPrompt] = useState("");
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
  const [accountStatus, setAccountStatus] = useState<AccountStatus>("loading");
  const [accountUser, setAccountUser] = useState<AccountUser | null>(null);
  const [accountError, setAccountError] = useState("");
  const [localOnly, setLocalOnly] = useState(false);
  const [accountReload, setAccountReload] = useState(0);
  const [syncState, setSyncState] = useState<SyncState>("idle");
  const modelPickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const hydrate = async () => {
      let localSettings = DEFAULT_SETTINGS;
      try {
        const saved = window.localStorage.getItem(STORAGE_KEY);
        if (saved) localSettings = { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } as Settings;
        if (window.sessionStorage.getItem("video-script-local-only") === "1") setLocalOnly(true);
      } catch {
        // Keep safe defaults if browser storage is unavailable or malformed.
      }

      try {
        const response = await fetch("/api/account/settings", { headers: { Accept: "application/json" } });
        const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
        if (cancelled) return;
        if (response.status === 401) {
          setSettings(localSettings);
          setDraftSettings(localSettings);
          setAccountStatus("anonymous");
          return;
        }
        if (!response.ok) throw new Error(String(payload.error ?? "账号服务暂时不可用"));
        const user = payload.user as AccountUser;
        const cloudSettings = payload.settings && typeof payload.settings === "object" ? payload.settings as Partial<Settings> : null;
        const nextSettings = cloudSettings ? { ...DEFAULT_SETTINGS, ...localSettings, ...cloudSettings } as Settings : localSettings;
        setSettings(nextSettings);
        setDraftSettings(nextSettings);
        setAccountUser(user);
        setAccountStatus("authenticated");
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextSettings));

        if (!cloudSettings && hasSavedKeys(localSettings)) {
          setSyncState("saving");
          const migrated = await fetch("/api/account/settings", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ settings: localSettings }),
          });
          if (!cancelled) setSyncState(migrated.ok ? "saved" : "error");
        }
      } catch (caught) {
        if (cancelled) return;
        setSettings(localSettings);
        setDraftSettings(localSettings);
        setAccountError(caught instanceof Error ? caught.message : "账号服务暂时不可用");
        setAccountStatus("error");
      }
    };
    void hydrate();
    return () => { cancelled = true; };
  }, [accountReload]);

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

  const customModel = useMemo<ModelOption>(() => ({
    id: "custom",
    name: settings.customName || settings.customModel || "自定义模型",
    provider: "自定义接口",
    note: settings.customModel || "填写 API 地址、Key 与模型 ID",
    mark: "C",
    tags: ["自定义"],
  }), [settings.customModel, settings.customName]);

  const allModels = useMemo(() => [...BUILTIN_MODELS, customModel], [customModel]);
  const selectedModel = allModels.find((item) => item.id === settings.summaryPreset) ?? allModels[0];
  const summaryConnection = useMemo(() => getSummaryConnection(settings), [settings]);

  const visibleModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    if (!query) return allModels;
    return allModels.filter((item) => `${item.name} ${item.id} ${item.note}`.toLowerCase().includes(query));
  }, [allModels, modelSearch]);

  const busy = stage === "resolving" || stage === "transcribing" || stage === "summarizing";
  const stageIndex = STAGE_INDEX[stage];
  const progress = stage === "resolving" ? 16 : stage === "transcribing" ? Math.min(72, 30 + pollCount * 4) : stage === "summarizing" ? 86 : stage === "done" ? 100 : 0;

  const syncCloudSettings = async (next: Settings) => {
    if (accountStatus !== "authenticated") return;
    setSyncState("saving");
    try {
      const response = await fetch("/api/account/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: next }),
      });
      if (!response.ok) throw new Error("同步失败");
      setSyncState("saved");
    } catch {
      setSyncState("error");
    }
  };

  const persistSettings = (next: Settings) => {
    setSettings(next);
    setDraftSettings(next);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    void syncCloudSettings(next);
  };

  const selectModel = (modelId: SummaryPreset) => {
    persistSettings({ ...settings, summaryPreset: modelId });
    setModelOpen(false);
    setModelSearch("");
    if (modelId === "custom" && (!settings.customBase || !settings.customKey || !settings.customModel)) {
      setDraftSettings({ ...settings, summaryPreset: "custom" });
      setSettingsOpen(true);
    }
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
      openRouterKey: draftSettings.openRouterKey.trim(),
      deepseekKey: draftSettings.deepseekKey.trim(),
      customName: draftSettings.customName.trim() || "我的模型",
      customBase: draftSettings.customBase.trim().replace(/\/+$/, ""),
      customKey: draftSettings.customKey.trim(),
      customModel: draftSettings.customModel.trim(),
    });
    setSettingsOpen(false);
  };

  const ensureReady = () => {
    const missing: string[] = [];
    if ((inputMode === "link" || inputMode === "bilibili") && !settings.tikhubKey) missing.push("TikHub API Key");
    if (settings.summaryPreset === "openrouter-free" && !settings.openRouterKey) missing.push("OpenRouter API Key");
    if ((settings.summaryPreset === "deepseek-flash" || settings.summaryPreset === "deepseek-pro") && !settings.deepseekKey) missing.push("DeepSeek API Key");
    if (settings.summaryPreset === "custom" && (!settings.customBase || !settings.customKey || !settings.customModel)) missing.push("自定义 API 地址、Key 与模型 ID");
    if (missing.length) {
      setError({
        service: "连接设置",
        reason: `还没有填写：${missing.join("、")}`,
        suggestion: accountStatus === "authenticated" ? "打开连接设置，填好后会自动保存到你的账号。" : "打开连接设置，填好后会保存在当前浏览器。",
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
        if (resolved.contentType === "image") {
          const recognized = await apiPost<{ transcript: string; resolvedModel?: string }>("/api/vision", {
            apiKey: summaryConnection.apiKey,
            baseUrl: summaryConnection.baseUrl,
            model: summaryConnection.model,
            providerName: summaryConnection.providerName,
            title: resolved.title,
            images: resolved.images,
          });
          transcript = [resolved.textContent, recognized.transcript].filter(Boolean).join("\n\n");
        } else {
          if (!settings.asrKey) {
            openSettings();
            throw {
              service: "连接设置",
              reason: "这是一条视频作品，但还没有填写火山 ASR API Key",
              suggestion: "图文作品不需要 ASR；视频作品需要在连接设置中填写 ASR Key。",
            } satisfies DisplayError;
          }
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
      const summarized = await apiPost<{ summary: string; resolvedModel?: string }>("/api/summarize", {
        apiKey: summaryConnection.apiKey,
        baseUrl: summaryConnection.baseUrl,
        model: summaryConnection.model,
        providerName: summaryConnection.providerName,
        thinking: summaryConnection.thinking,
        prompt: generationPrompt.trim(),
        source,
        transcript,
      });

      const reportedModel = settings.summaryPreset === "openrouter-free" && summarized.resolvedModel
        ? `${summaryConnection.displayName} · ${summarized.resolvedModel}`
        : summaryConnection.displayName;
      setResult({ source, transcript, summary: summarized.summary, model: reportedModel });
      const sourceUrl = inputMode === "link" ? (cleanInput.match(/https?:\/\/\S+/)?.[0] ?? "") : "";
      await saveHistoryDocument({
        platform: inputMode === "link" ? "douyin" : "manual",
        sourceId: source.awemeId,
        sourceUrl,
        title: source.title,
        author: source.author,
        originalTranscript: transcript,
        workingContent: summarized.summary,
        initialSummary: summarized.summary,
        lastPrompt: generationPrompt.trim(),
        model: reportedModel,
        method: inputMode === "text" ? "手动导入" : source.contentType === "image" ? "抖音图文识别" : "豆包 ASR",
      }).catch(() => undefined);
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
    ? `# ${result.source.title}\n\n作者：${result.source.author}\n生成模型：${result.model}\n\n## AI 成稿\n\n${result.summary}\n\n## 完整文字稿\n\n${result.transcript}\n`
    : "";

  if ((accountStatus === "loading" || accountStatus === "error" || accountStatus === "anonymous") && !localOnly) {
    return (
      <LoginGate
        status={accountStatus}
        error={accountError}
        onRetry={() => { setAccountError(""); setAccountStatus("loading"); setAccountReload((value) => value + 1); }}
        onContinueLocally={() => {
          window.sessionStorage.setItem("video-script-local-only", "1");
          setLocalOnly(true);
        }}
      />
    );
  }

  return (
    <main className="app-shell">
      <aside className="side-rail" aria-label="主要导航">
        <div className="brand-mark" title="抖音成稿">稿</div>
        <nav>
          <button className={`rail-button ${workspaceView === "create" ? "active" : ""}`} onClick={() => setWorkspaceView("create")} aria-label="新建成稿" title="新建成稿">＋</button>
          <button className={`rail-button history-rail ${workspaceView === "history" ? "active" : ""}`} onClick={() => setWorkspaceView("history")} aria-label="历史文稿" title="历史文稿">历</button>
        </nav>
        <button className="rail-button rail-settings" onClick={openSettings} aria-label="连接设置" title="连接设置">⚙</button>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">视频成稿</p>
            <h1>{workspaceView === "history" ? "每一份文稿，都可以继续生长" : "把视频和图文，变成一份能用的文字"}</h1>
            <p className="hero-note">{workspaceView === "history" ? "找回原始转写，手动修改，或用新的提示词让 AI 接着改。" : "抖音单条、B站 UP 主批量导入，再按你的提示词写成文章。"}</p>
          </div>

          <div className="topbar-actions">
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
                  <span className="model-count">{allModels.length} 个选项</span>
                </div>
                <label className="model-search">
                  <span>⌕</span>
                  <input
                    value={modelSearch}
                    onChange={(event) => setModelSearch(event.target.value)}
                    placeholder="搜索模型"
                  />
                </label>
                <p className="model-group">总结模型</p>
                <div role="listbox">
                  {visibleModels.map((item) => (
                    <button
                      className={`model-row ${selectedModel.id === item.id ? "selected" : ""}`}
                      key={item.id}
                      onClick={() => selectModel(item.id)}
                      role="option"
                      aria-selected={selectedModel.id === item.id}
                    >
                      <span className={`model-avatar small ${item.id === "custom" ? "custom" : ""}`}>{item.mark}</span>
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
                <button className="model-manage" onClick={openSettings}>⚙ 管理模型与 API</button>
              </div>
            )}
          </div>
          {accountStatus === "authenticated" && accountUser ? (
            <details className="account-menu">
              <summary aria-label="账号菜单">
                <span>{(accountUser.displayName || accountUser.email).slice(0, 1).toUpperCase()}</span>
                <i className={syncState === "error" ? "error" : ""}>{syncState === "saving" ? "同步中" : syncState === "error" ? "同步失败" : "已登录"}</i>
              </summary>
              <div>
                <b>{accountUser.displayName}</b>
                <small>{accountUser.email}</small>
                <p><i className={syncState === "saved" ? "ok" : ""} />{syncState === "saving" ? "正在加密保存设置" : syncState === "error" ? "云端保存失败，本机设置仍然可用" : "API Key 会自动同步到你的账号"}</p>
                <a href="/signout-with-chatgpt?return_to=%2F">退出登录</a>
              </div>
            </details>
          ) : (
            <a className="account-login-link" href="/signin-with-chatgpt?return_to=%2F">登录并同步</a>
          )}
          </div>
        </header>

        {workspaceView === "history" ? (
          <HistoryWorkspace
            summaryConnection={summaryConnection}
            signedIn={accountStatus === "authenticated"}
            onOpenSettings={openSettings}
            onCreateNew={() => setWorkspaceView("create")}
          />
        ) : <>
        <div className="source-tabs" aria-label="内容来源">
          <button className={inputMode === "link" ? "active" : ""} onClick={() => setInputMode("link")}><i>抖</i><span><b>抖音单条</b><small>视频 / 图文自动识别</small></span></button>
          <button className={inputMode === "bilibili" ? "active" : ""} onClick={() => setInputMode("bilibili")}><i>B</i><span><b>B站主页</b><small>读取标题并批量选择</small></span></button>
          <button className={inputMode === "text" ? "active" : ""} onClick={() => setInputMode("text")}><i>文</i><span><b>已有文稿</b><small>跳过采集与识别</small></span></button>
        </div>

        {inputMode === "bilibili" ? (
          <BilibiliImporter
            tikhubKey={settings.tikhubKey}
            asrKey={settings.asrKey}
            asrResourceId={settings.asrResourceId}
            generationPrompt={generationPrompt}
            onGenerationPromptChange={setGenerationPrompt}
            summaryConnection={summaryConnection}
            onOpenSettings={openSettings}
          />
        ) : <div className="content-grid">
          <section className="input-card">
            <div className="input-card-top">
              <div className="card-heading">
                <span className="step-number">01</span>
                <div>
                  <h2>{inputMode === "link" ? "粘贴视频链接" : "粘贴已有文字稿"}</h2>
                  <p>{inputMode === "link" ? "支持抖音分享口令或完整链接" : "跳过语音识别，直接进行 AI 总结"}</p>
                </div>
              </div>
            </div>
            <textarea
              className="source-input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              aria-label={inputMode === "link" ? "抖音视频链接" : "已有文字稿"}
              placeholder={
                inputMode === "link"
                  ? "把抖音分享内容粘贴到这里…\n视频会做语音识别；图文会自动读取图片文字。\n例如：https://v.douyin.com/xxxx/"
                  : "把抖音或豆包已经生成的文字稿粘贴到这里…"
              }
              disabled={busy}
            />
            <div className="prompt-composer">
              <div className="prompt-heading">
                <div>
                  <b>生成提示词</b>
                  <span>可选 · 告诉 AI 最后要写成什么样</span>
                </div>
                <small>{generationPrompt.length}/2000</small>
              </div>
              <textarea
                className="prompt-input"
                value={generationPrompt}
                onChange={(event) => setGenerationPrompt(event.target.value)}
                placeholder="例如：整理成一篇适合公众号发布的文章，保留原作者观点，增加清晰的小标题……"
                aria-label="生成提示词"
                maxLength={2000}
                disabled={busy}
              />
              <div className="prompt-examples" aria-label="提示词示例">
                {PROMPT_EXAMPLES.map((example, index) => (
                  <button key={example} onClick={() => setGenerationPrompt(example)} disabled={busy} title={example}>
                    {index === 0 ? "公众号文章" : index === 1 ? "小红书笔记" : "精简要点"}
                  </button>
                ))}
                {generationPrompt && <button className="clear-prompt" onClick={() => setGenerationPrompt("")} disabled={busy}>清空</button>}
              </div>
            </div>
            <div className="input-footer">
              <span className="privacy-note"><i /> {inputMode === "link" ? "视频由火山服务器读取，不在网站保存" : `${input.length} 个字符`}</span>
              <button className="primary-button" onClick={handleGenerate} disabled={busy}>
                {busy ? "正在处理" : "开始生成"} <span>{busy ? "···" : "→"}</span>
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
                  <div><b>成稿</b><span>按照提示词生成需要的文章</span></div>
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
                    [2, "内容转文字", pollCount ? `正在查询识别结果 · ${pollCount}` : "视频走豆包 ASR，图文走视觉识别"],
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
              <span>ASR / 图文识别</span><i />
              <span>{selectedModel.name}</span>
            </div>
          </aside>
        </div>}

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
              <button className={resultTab === "summary" ? "active" : ""} onClick={() => setResultTab("summary")} role="tab">AI 成稿</button>
              <button className={resultTab === "transcript" ? "active" : ""} onClick={() => setResultTab("transcript")} role="tab">完整文字稿</button>
            </div>
            <article className={resultTab === "summary" ? "summary-content" : "transcript-content"}>
              {resultTab === "summary" ? result.summary : result.transcript}
            </article>
          </section>
        )}
        </>}
      </section>

      {settingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSettingsOpen(false);
        }}>
          <section className="settings-modal" role="dialog" aria-modal="true" aria-label="连接设置">
            <header>
              <div>
                <p className="eyebrow">连接设置</p>
                <h2>连接服务与总结模型</h2>
                <span>{accountStatus === "authenticated" ? "密钥会加密保存到你的账号，并在下次登录时自动恢复。" : "选择默认、DeepSeek 或自定义模型。密钥只保存在这个浏览器。"}</span>
              </div>
              <button className="modal-close" onClick={() => setSettingsOpen(false)} aria-label="关闭">×</button>
            </header>

            <div className="settings-body">
              <div className="provider-section">
                <div className="provider-title"><i>1</i><span><b>TikHub</b><small>读取抖音作品与 B站 UP 主公开视频</small></span><em className={draftSettings.tikhubKey ? "ok" : ""}>{draftSettings.tikhubKey ? "已填写" : "待填写"}</em></div>
                <label><span>API Key</span><input type={showKeys ? "text" : "password"} value={draftSettings.tikhubKey} onChange={(event) => setDraftSettings({ ...draftSettings, tikhubKey: event.target.value })} placeholder="tk_..." autoComplete="off" /></label>
              </div>

              <div className="provider-section">
                <div className="provider-title"><i>2</i><span><b>火山豆包 ASR</b><small>录音文件识别 2.0，生成完整文稿</small></span><em className={draftSettings.asrKey ? "ok" : ""}>{draftSettings.asrKey ? "已填写" : "待填写"}</em></div>
                <div className="field-grid">
                  <label><span>ASR API Key</span><input type={showKeys ? "text" : "password"} value={draftSettings.asrKey} onChange={(event) => setDraftSettings({ ...draftSettings, asrKey: event.target.value })} placeholder="火山语音控制台的 API Key" autoComplete="off" /></label>
                  <label><span>资源 ID</span><input value={draftSettings.asrResourceId} onChange={(event) => setDraftSettings({ ...draftSettings, asrResourceId: event.target.value })} /></label>
                </div>
              </div>

              <div className={`provider-section ${draftSettings.summaryPreset === "openrouter-free" ? "active-provider" : ""}`}>
                <div className="provider-title">
                  <i>3</i>
                  <span><b>免费总结 · OpenRouter</b><small>免费模型自动路由，适合测试与低频使用</small></span>
                  <button className="preset-button" onClick={() => setDraftSettings({ ...draftSettings, summaryPreset: "openrouter-free" })}>{draftSettings.summaryPreset === "openrouter-free" ? "当前使用" : "设为当前"}</button>
                </div>
                <label><span>OpenRouter API Key</span><input type={showKeys ? "text" : "password"} value={draftSettings.openRouterKey} onChange={(event) => setDraftSettings({ ...draftSettings, openRouterKey: event.target.value })} placeholder="sk-or-v1-..." autoComplete="off" /></label>
                <p className="provider-tip">模型 ID 固定为 openrouter/free。免费路由可能排队或限流，适合前期测试。</p>
              </div>

              <div className={`provider-section ${draftSettings.summaryPreset.startsWith("deepseek-") ? "active-provider" : ""}`}>
                <div className="provider-title">
                  <i>4</i>
                  <span><b>DeepSeek V4</b><small>Flash 日常总结，Pro 处理复杂长文</small></span>
                  <em className={draftSettings.deepseekKey ? "ok" : ""}>{draftSettings.deepseekKey ? "已填写" : "待填写"}</em>
                </div>
                <label><span>DeepSeek API Key</span><input type={showKeys ? "text" : "password"} value={draftSettings.deepseekKey} onChange={(event) => setDraftSettings({ ...draftSettings, deepseekKey: event.target.value })} placeholder="sk-..." autoComplete="off" /></label>
                <div className="preset-pair">
                  <button className={draftSettings.summaryPreset === "deepseek-flash" ? "active" : ""} onClick={() => setDraftSettings({ ...draftSettings, summaryPreset: "deepseek-flash" })}><b>V4 Flash</b><small>快速、低成本</small></button>
                  <button className={draftSettings.summaryPreset === "deepseek-pro" ? "active" : ""} onClick={() => setDraftSettings({ ...draftSettings, summaryPreset: "deepseek-pro" })}><b>V4 Pro</b><small>复杂内容、深度整理</small></button>
                </div>
                <div className="thinking-setting">
                  <span>V4 Pro 思考强度</span>
                  <div>
                    {(["disabled", "high", "max"] as ThinkingLevel[]).map((level) => (
                      <button className={draftSettings.deepseekThinking === level ? "active" : ""} key={level} onClick={() => setDraftSettings({ ...draftSettings, deepseekThinking: level })}>
                        {level === "disabled" ? "快速" : level === "high" ? "深入" : "最大"}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className={`provider-section ${draftSettings.summaryPreset === "custom" ? "active-provider" : ""}`}>
                <div className="provider-title">
                  <i>5</i>
                  <span><b>自定义模型</b><small>支持 OpenAI 兼容的 chat/completions 接口</small></span>
                  <button className="preset-button" onClick={() => setDraftSettings({ ...draftSettings, summaryPreset: "custom" })}>{draftSettings.summaryPreset === "custom" ? "当前使用" : "设为当前"}</button>
                </div>
                <div className="field-grid">
                  <label><span>显示名称</span><input value={draftSettings.customName} onChange={(event) => setDraftSettings({ ...draftSettings, customName: event.target.value })} placeholder="我的总结模型" /></label>
                  <label><span>模型 ID</span><input value={draftSettings.customModel} onChange={(event) => setDraftSettings({ ...draftSettings, customModel: event.target.value })} placeholder="provider/model-name" /></label>
                </div>
                <label><span>API 地址</span><input value={draftSettings.customBase} onChange={(event) => setDraftSettings({ ...draftSettings, customBase: event.target.value })} placeholder="https://example.com/v1" /></label>
                <label><span>API Key</span><input type={showKeys ? "text" : "password"} value={draftSettings.customKey} onChange={(event) => setDraftSettings({ ...draftSettings, customKey: event.target.value })} placeholder="sk-..." autoComplete="off" /></label>
              </div>
            </div>

            <footer>
              <label className="show-key-toggle"><input type="checkbox" checked={showKeys} onChange={(event) => setShowKeys(event.target.checked)} /> 显示密钥 · {accountStatus === "authenticated" ? syncState === "saving" ? "正在同步" : syncState === "error" ? "同步失败" : "账号自动保存" : "本机保存"}</label>
              <div><button className="cancel-button" onClick={() => setSettingsOpen(false)}>取消</button><button className="primary-button" onClick={saveSettings}>保存设置 <span>✓</span></button></div>
            </footer>
          </section>
        </div>
      )}
    </main>
  );
}
