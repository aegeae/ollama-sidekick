export type BackgroundRequest =
  | { type: 'OLLAMA_LIST_MODELS' }
  | { type: 'OLLAMA_GENERATE'; prompt: string; model?: string };

export type BackgroundResponse =
  | { ok: true; type: 'OLLAMA_LIST_MODELS_RESULT'; models: string[] }
  | { ok: true; type: 'OLLAMA_GENERATE_RESULT'; text: string }
  | {
      ok: false;
      type: 'ERROR';
      error: { message: string; status?: number; url?: string; hint?: string };
    };
