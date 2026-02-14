export type ContextPreviewCacheKeyInput = {
  tabId: number | null;
  includeSelection: boolean;
  includeExcerpt: boolean;
  maxChars: number;
  consoleContextVersion?: number;
  netContextVersion?: number;
  contextCleared?: boolean;
};

export function buildContextPreviewCacheKey(input: ContextPreviewCacheKeyInput): string {
  const tabPart = typeof input.tabId === 'number' && Number.isFinite(input.tabId) && input.tabId > 0 ? String(Math.floor(input.tabId)) : 'active';
  const max = Number.isFinite(input.maxChars) ? Math.max(0, Math.floor(input.maxChars)) : 0;
  const verRaw = input.consoleContextVersion;
  const ver = typeof verRaw === 'number' && Number.isFinite(verRaw) ? Math.max(0, Math.floor(verRaw)) : 0;

  const netVerRaw = input.netContextVersion;
  const netVer = typeof netVerRaw === 'number' && Number.isFinite(netVerRaw) ? Math.max(0, Math.floor(netVerRaw)) : 0;
  const cleared = input.contextCleared === true;

  return [
    `tab:${tabPart}`,
    `sel:${input.includeSelection ? '1' : '0'}`,
    `ex:${input.includeExcerpt ? '1' : '0'}`,
    `max:${max}`,
    `ccv:${ver}`,
    `ncv:${netVer}`,
    `clr:${cleared ? '1' : '0'}`
  ].join('|');
}
