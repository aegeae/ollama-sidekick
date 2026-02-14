function safeLower(s: string): string {
  return (s ?? '').toLowerCase();
}

export function isRestrictedUrl(url: string): boolean {
  const u = safeLower(url.trim());
  if (!u) return false;

  // Browser internal pages
  if (u.startsWith('chrome://') || u.startsWith('brave://') || u.startsWith('edge://') || u.startsWith('about:')) return true;

  // Extension pages
  if (u.startsWith('chrome-extension://')) return true;

  // Chrome Web Store / extensions gallery
  if (u.startsWith('https://chrome.google.com/webstore') || u.startsWith('https://chromewebstore.google.com/')) return true;

  // file:// pages typically cannot be scripted unless explicitly allowed.
  if (u.startsWith('file://')) return true;

  return false;
}

export function getRestrictedPageHint(url?: string): string | null {
  const u = safeLower((url ?? '').trim());

  if (!u) {
    return 'Context cannot be read on this page (Chrome Web Store / browser pages). Switch to a normal webpage and try again.';
  }

  if (u.startsWith('https://chrome.google.com/webstore') || u.startsWith('https://chromewebstore.google.com/')) {
    return 'Context cannot be read on the Chrome Web Store. Open a normal webpage and try again.';
  }

  if (u.startsWith('chrome://') || u.startsWith('brave://') || u.startsWith('edge://') || u.startsWith('about:')) {
    return 'Context cannot be read on browser internal pages. Open a normal webpage and try again.';
  }

  if (u.startsWith('chrome-extension://')) {
    return 'Context cannot be read on extension pages. Switch to a normal webpage and try again.';
  }

  if (u.startsWith('file://')) {
    return 'Context cannot be read on local file pages unless the browser allows it. Open a normal webpage and try again.';
  }

  return null;
}
