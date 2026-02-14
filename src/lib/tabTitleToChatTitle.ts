export function tabTitleToChatTitle(tabTitle: string): string {
  return String(tabTitle ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}
