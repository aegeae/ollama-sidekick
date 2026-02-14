export type BackgroundRequest =
  | { type: 'OLLAMA_LIST_MODELS' }
  | { type: 'OLLAMA_GENERATE'; prompt: string; model?: string }
  | { type: 'TAB_CONTEXT_GET'; maxChars?: number };

export type TabContext = {
  title: string;
  url: string;
  selection: string;
  textExcerpt: string;
};

export type BackgroundResponse =
  | { ok: true; type: 'OLLAMA_LIST_MODELS_RESULT'; models: string[] }
  | { ok: true; type: 'OLLAMA_GENERATE_RESULT'; text: string }
  | { ok: true; type: 'TAB_CONTEXT_GET_RESULT'; context: TabContext }
  | {
      ok: false;
      type: 'ERROR';
      error: { message: string; status?: number; url?: string; hint?: string };
    };
