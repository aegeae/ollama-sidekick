export type ConsoleLogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export type TabConsoleLogEntry = {
  ts: number;
  level: ConsoleLogLevel;
  text: string;
};

export type NetCaptureKind = 'fetch' | 'xhr';

export type TabNetLogEntry = {
  ts: number;
  kind: NetCaptureKind;
  method: string;
  url: string;
  status: number | null;
  durationMs: number | null;
  error?: string;
  requestBodyText?: string;
  responseBodyText?: string;
  bodyTruncated?: boolean;
};

export type BackgroundRequest =
  | { type: 'OLLAMA_LIST_MODELS' }
  | { type: 'OLLAMA_GENERATE'; prompt: string; model?: string }
  | { type: 'OLLAMA_MODEL_INFO_GET'; model: string }
  | { type: 'TAB_INFO_GET'; tabId?: number }
  | { type: 'TAB_TARGET_GET'; tabId?: number }
  | {
      type: 'TAB_CONTEXT_GET';
      maxChars?: number;
      tabId?: number;
      includeSelection?: boolean;
      includeExcerpt?: boolean;
    }
  | { type: 'TAB_CONSOLE_CAPTURE_START'; tabId?: number }
  | { type: 'TAB_CONSOLE_CAPTURE_STOP'; tabId?: number }
  | { type: 'TAB_CONSOLE_LOGS_GET'; tabId?: number }
  | { type: 'TAB_CONSOLE_LOGS_CLEAR'; tabId?: number }
  | { type: 'TAB_CONSOLE_LOG_ENTRY'; entry: TabConsoleLogEntry }
  | { type: 'TAB_NET_CAPTURE_START'; tabId?: number; includeBodies?: boolean }
  | { type: 'TAB_NET_CAPTURE_STOP'; tabId?: number }
  | { type: 'TAB_NET_LOGS_GET'; tabId?: number }
  | { type: 'TAB_NET_LOGS_CLEAR'; tabId?: number }
  | { type: 'TAB_NET_LOG_ENTRY'; entry: TabNetLogEntry };

export type TabInfo = {
  title: string;
  url: string;
};

export type TabContext = {
  title: string;
  url: string;
  selection: string;
  textExcerpt: string;
};

export type BackgroundResponse =
  | { ok: true; type: 'OLLAMA_LIST_MODELS_RESULT'; models: string[] }
  | { ok: true; type: 'OLLAMA_GENERATE_RESULT'; text: string }
  | { ok: true; type: 'OLLAMA_MODEL_INFO_GET_RESULT'; model: string; tokenBudget: number | null }
  | { ok: true; type: 'TAB_INFO_GET_RESULT'; tab: TabInfo }
  | {
      ok: true;
      type: 'TAB_TARGET_GET_RESULT';
      tabId: number;
      title: string;
      url: string;
      domain: string;
      restricted: boolean;
      hint?: string;
    }
  | { ok: true; type: 'TAB_CONTEXT_GET_RESULT'; context: TabContext }
  | { ok: true; type: 'TAB_CONSOLE_CAPTURE_START_RESULT'; tabId: number; capturing: true }
  | { ok: true; type: 'TAB_CONSOLE_CAPTURE_STOP_RESULT'; tabId: number; capturing: false }
  | { ok: true; type: 'TAB_CONSOLE_LOGS_GET_RESULT'; tabId: number; capturing: boolean; logs: TabConsoleLogEntry[] }
  | { ok: true; type: 'TAB_CONSOLE_LOGS_CLEAR_RESULT'; tabId: number }
  | { ok: true; type: 'TAB_CONSOLE_LOG_ENTRY_ACK'; tabId: number }
  | { ok: true; type: 'TAB_NET_CAPTURE_START_RESULT'; tabId: number; capturing: true }
  | { ok: true; type: 'TAB_NET_CAPTURE_STOP_RESULT'; tabId: number; capturing: false }
  | { ok: true; type: 'TAB_NET_LOGS_GET_RESULT'; tabId: number; capturing: boolean; logs: TabNetLogEntry[] }
  | { ok: true; type: 'TAB_NET_LOGS_CLEAR_RESULT'; tabId: number }
  | { ok: true; type: 'TAB_NET_LOG_ENTRY_ACK'; tabId: number }
  | {
      ok: false;
      type: 'ERROR';
      error: { message: string; status?: number; url?: string; hint?: string };
    };
