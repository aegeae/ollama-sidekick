export type CompiledDiagnosticsFilter = {
  raw: string;
  kind: 'all' | 'regex' | 'text';
  matcher: (value: string) => boolean;
  error?: string;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findRegexLiteralDelimiter(input: string): number | null {
  // Finds the closing '/' in a /pattern/flags literal.
  // We treat a slash as a delimiter if it's not escaped by an odd number of backslashes.
  if (!input.startsWith('/')) return null;

  for (let i = input.length - 1; i > 0; i--) {
    if (input[i] !== '/') continue;

    let backslashes = 0;
    for (let j = i - 1; j >= 0 && input[j] === '\\'; j--) backslashes++;

    const isEscaped = backslashes % 2 === 1;
    if (!isEscaped) return i;
  }

  return null;
}

function parseRegexLiteral(input: string): { pattern: string; flags: string } | null {
  const end = findRegexLiteralDelimiter(input);
  if (end == null) return null;

  const pattern = input.slice(1, end);
  const flags = input.slice(end + 1);
  return { pattern, flags };
}

export function compileDiagnosticsFilter(raw: string): CompiledDiagnosticsFilter {
  const normalized = String(raw ?? '').trim();

  if (!normalized || normalized === '*') {
    return {
      raw: normalized || '*',
      kind: 'all',
      matcher: () => true
    };
  }

  const literal = parseRegexLiteral(normalized);
  if (literal) {
    try {
      const re = new RegExp(literal.pattern, literal.flags);
      return {
        raw: normalized,
        kind: 'regex',
        matcher: (value: string) => re.test(value)
      };
    } catch (e) {
      return {
        raw: normalized,
        kind: 'regex',
        matcher: () => true,
        error: `Invalid regex: ${e instanceof Error ? e.message : String(e)}`
      };
    }
  }

  try {
    const re = new RegExp(escapeRegExp(normalized), 'i');
    return {
      raw: normalized,
      kind: 'text',
      matcher: (value: string) => re.test(value)
    };
  } catch (e) {
    return {
      raw: normalized,
      kind: 'text',
      matcher: () => true,
      error: `Invalid filter: ${e instanceof Error ? e.message : String(e)}`
    };
  }
}
