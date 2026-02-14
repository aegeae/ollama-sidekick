type OllamaTagsResponse = {
  models?: Array<{ name: string }>;
};

type OllamaGenerateResponse = {
  response?: string;
  done?: boolean;
  error?: string;
};

type OllamaShowResponse = Record<string, unknown>;

export type HttpErrorDetails = {
  url: string;
  status: number;
  statusText: string;
  bodyText?: string;
  hint?: string;
};

export class HttpError extends Error {
  readonly details: HttpErrorDetails;

  constructor(message: string, details: HttpErrorDetails) {
    super(message);
    this.name = 'HttpError';
    this.details = details;
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) throw new Error('Base URL is empty');
  return trimmed.replace(/\/+$/, '');
}

async function httpJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    // e.g. DNS failure, connection refused, etc.
    const hint = 'Is Ollama running and reachable at the configured Base URL?';
    throw new Error(`${err instanceof Error ? err.message : String(err)}. ${hint}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const base = `HTTP ${res.status} ${res.statusText}`;

    let hint: string | undefined;

    // Common when Ollama rejects the request Origin (extensions send Origin: chrome-extension://...).
    if (res.status === 403) {
      hint =
        'Ollama likely rejected the request Origin (extensions send chrome-extension://...). ' +
        'Restart Ollama with an allowlist, e.g. `OLLAMA_ORIGINS=* ollama serve` (or allow your chrome-extension://<id> origin), then retry.';
    }

    const message = `${base}${text ? `: ${text}` : ''}`;
    throw new HttpError(message, {
      url,
      status: res.status,
      statusText: res.statusText,
      bodyText: text || undefined,
      hint
    });
  }
  return (await res.json()) as T;
}

export async function listModels(baseUrl: string): Promise<string[]> {
  const normalized = normalizeBaseUrl(baseUrl);
  const data = await httpJson<OllamaTagsResponse>(`${normalized}/api/tags`);
  const names = (data.models ?? []).map((m) => m.name).filter(Boolean);
  // de-dupe
  return Array.from(new Set(names));
}

export async function generate(baseUrl: string, model: string, prompt: string): Promise<string> {
  if (!prompt || !prompt.trim()) throw new Error('Prompt is empty');

  const normalized = normalizeBaseUrl(baseUrl);
  const trimmedModel = model.trim();
  if (!trimmedModel) throw new Error('Model is empty');

  const data = await httpJson<OllamaGenerateResponse>(`${normalized}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: trimmedModel,
      prompt,
      stream: false
    })
  });

  if (data.error) throw new Error(data.error);
  return data.response ?? '';
}

export async function showModel(baseUrl: string, model: string): Promise<OllamaShowResponse> {
  const normalized = normalizeBaseUrl(baseUrl);
  const trimmedModel = model.trim();
  if (!trimmedModel) throw new Error('Model is empty');

  return await httpJson<OllamaShowResponse>(`${normalized}/api/show`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: trimmedModel })
  });
}
