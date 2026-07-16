export const buildPublicPortfolioUrl = (slug: string): string => {
  const safe = String(slug || '').trim();
  if (!safe) return '';
  const path = `/portfolio/${encodeURIComponent(safe)}`;
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}${path}`;
  }
  return path;
};

export const copyPublicPortfolioLink = async (slug: string): Promise<boolean> => {
  const url = buildPublicPortfolioUrl(slug);
  if (!url) return false;

  try {
    await navigator.clipboard.writeText(url);
    return true;
  } catch {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = url;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      return ok;
    } catch {
      return false;
    }
  }
};
