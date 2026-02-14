export type ContextPreviewCacheKeyInput = {
  tabId: number | null;
  includeSelection: boolean;
  includeExcerpt: boolean;
  maxChars: number;
};

export function buildContextPreviewCacheKey(input: ContextPreviewCacheKeyInput): string {
  const tabPart = typeof input.tabId === 'number' && Number.isFinite(input.tabId) && input.tabId > 0 ? String(Math.floor(input.tabId)) : 'active';
  const max = Number.isFinite(input.maxChars) ? Math.max(0, Math.floor(input.maxChars)) : 0;

  return [`tab:${tabPart}`, `sel:${input.includeSelection ? '1' : '0'}`, `ex:${input.includeExcerpt ? '1' : '0'}`, `max:${max}`].join('|');
}
