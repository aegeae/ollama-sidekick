import type { Settings } from './settings';

const SANS_STACK = 'system-ui, "Segoe UI", Roboto, Helvetica, Arial, "Noto Sans", "Liberation Sans", sans-serif';
const SERIF_STACK = 'ui-serif, Georgia, Cambria, "Times New Roman", Times, "Noto Serif", "Liberation Serif", serif';
const JETBRAINS_MONO_STACK =
  '"JetBrains Mono", ui-monospace, "Cascadia Mono", "Segoe UI Mono", Consolas, "Liberation Mono", "Courier New", monospace';

const MONO_STACK = 'ui-monospace, "Cascadia Mono", "Segoe UI Mono", Consolas, "Liberation Mono", "Courier New", monospace';

export function getFontFamilyStack(fontFamily: Settings['fontFamily']): string {
  switch (fontFamily) {
    case 'jetbrainsMono':
      return JETBRAINS_MONO_STACK;
    case 'mono':
      return MONO_STACK;
    case 'serif':
      return SERIF_STACK;
    case 'sans':
    case 'system':
    default:
      return SANS_STACK;
  }
}

export function applyUiSettings(settings: Settings, doc: Document = document): void {
  doc.documentElement.dataset.theme = settings.theme;
  doc.documentElement.style.setProperty('--ui-font-family', getFontFamilyStack(settings.fontFamily));
  doc.documentElement.style.setProperty('--ui-font-size', `${settings.fontSize}px`);
}
