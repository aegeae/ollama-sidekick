function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function asPositiveInt(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = Math.floor(v);
  if (n <= 0) return null;
  if (n > 1_000_000) return null;
  return n;
}

export function extractTokenBudget(showResponse: unknown): number | null {
  if (!isRecord(showResponse)) return null;

  // Common direct fields (best-effort; do not assume they're present).
  const direct =
    asPositiveInt((showResponse as any).context_length) ??
    asPositiveInt((showResponse as any).contextLength) ??
    asPositiveInt((showResponse as any).num_ctx) ??
    asPositiveInt((showResponse as any).numCtx);
  if (direct != null) return direct;

  // Ollama often exposes structured key/value metadata in `model_info`.
  const modelInfo = (showResponse as any).model_info;
  if (isRecord(modelInfo)) {
    const preferredKeys = [
      'llama.context_length',
      'llama.context_len',
      'context_length',
      'context_len',
      'num_ctx'
    ];
    for (const k of preferredKeys) {
      const v = asPositiveInt(modelInfo[k]);
      if (v != null) return v;
    }

    // Fallback: scan for any numeric context-like key.
    for (const [k, vRaw] of Object.entries(modelInfo)) {
      const key = k.toLowerCase();
      if (!key.includes('context')) continue;
      const v = asPositiveInt(vRaw);
      if (v != null) return v;
    }
  }

  return null;
}
