import { Modal, Typography, Button, Space, message } from 'antd';

export const buildPublicPortfolioUrl = (slug: string): string => {
  const safe = String(slug || '').trim();
  if (!safe) return '';
  const path = `/portfolio/${encodeURIComponent(safe)}`;
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}${path}`;
  }
  return path;
};

const tryCopyText = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      textarea.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      return ok;
    } catch {
      return false;
    }
  }
};

export const copyPublicPortfolioLink = async (slug: string): Promise<boolean> => {
  const url = buildPublicPortfolioUrl(slug);
  if (!url) return false;
  return tryCopyText(url);
};

/** Copy + always show URL in a modal so mobile users see feedback even if clipboard is blocked. */
export const sharePublicPortfolioLink = async (slug: string, options?: { title?: string }): Promise<string> => {
  const url = buildPublicPortfolioUrl(slug);
  if (!url) {
    message.warning('Нет slug кабинета — публичная ссылка недоступна');
    return '';
  }

  const copied = await tryCopyText(url);
  if (copied) {
    message.success('Ссылка скопирована');
  } else {
    message.warning('Буфер обмена недоступен — скопируйте вручную');
  }

  Modal.info({
    title: options?.title || 'Публичная ссылка мониторинга',
    width: 560,
    content: (
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {copied
            ? 'Ссылка уже в буфере. Можно также скопировать вручную:'
            : 'Скопируйте ссылку вручную:'}
        </Typography.Paragraph>
        <Typography.Paragraph
          copyable={{ text: url }}
          code
          style={{ marginBottom: 0, wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}
        >
          {url}
        </Typography.Paragraph>
        <Button type="link" href={url} target="_blank" rel="noopener noreferrer" style={{ padding: 0 }}>
          Открыть в новой вкладке
        </Button>
      </Space>
    ),
    okText: 'Закрыть',
  });

  return url;
};
