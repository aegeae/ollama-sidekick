export type TabContextLike = {
  title?: string;
  url?: string;
  selection?: string;
  textExcerpt?: string;
};

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export function buildContextBlock(ctx: TabContextLike): string {
  const selection = (ctx.selection ?? '').trim();
  const excerpt = (ctx.textExcerpt ?? '').trim();
  const body = selection || excerpt || '';
  const clipped = clip(body, 2000);

  return [
    'Context (active tab):',
    `Title: ${ctx.title ?? ''}`,
    `URL: ${ctx.url ?? ''}`,
    '',
    '```',
    clipped,
    '```',
    ''
  ].join('\n');
}

export function buildPromptWithOptionalContext(userPrompt: string, ctx?: TabContextLike | null): string {
  const prompt = String(userPrompt ?? '');
  if (!ctx) return prompt;
  return buildContextBlock(ctx) + prompt;
}
