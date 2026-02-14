export type BackgroundRequest =
  | { type: 'OLLAMA_LIST_MODELS' }
  | { type: 'OLLAMA_GENERATE'; prompt: string; model?: string }
  | { type: 'OLLAMA_MODEL_INFO_GET'; model: string }
  | { type: 'TAB_INFO_GET'; tabId?: number }
  | {
      type: 'TAB_CONTEXT_GET';
      maxChars?: number;
      tabId?: number;
      includeSelection?: boolean;
      includeExcerpt?: boolean;
    };

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
  | { ok: true; type: 'TAB_CONTEXT_GET_RESULT'; context: TabContext }
  | {
      ok: false;
      type: 'ERROR';
      error: { message: string; status?: number; url?: string; hint?: string };
    };
