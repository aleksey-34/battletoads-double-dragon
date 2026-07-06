import path from 'path';

export const CLIENT_GUIDES_ROOT_DIR = path.resolve(__dirname, '../../../..', 'docs', 'exchange-guides');
export const CLIENT_GUIDES_IMAGES_DIR = path.join(CLIENT_GUIDES_ROOT_DIR, 'images');

export const CLIENT_EXCHANGE_GUIDES: Record<string, { id: string; title: string; fileName: string }> = {
  bybit: {
    id: 'bybit',
    title: 'Bybit API Key Quick Guide',
    fileName: 'bybit-api-key-quick-guide.md',
  },
  binance: {
    id: 'binance',
    title: 'Binance API Key Quick Guide',
    fileName: 'binance-api-key-quick-guide.md',
  },
  bingx: {
    id: 'bingx',
    title: 'BingX API Key Quick Guide',
    fileName: 'bingx-api-key-quick-guide.md',
  },
  bitget: {
    id: 'bitget',
    title: 'Bitget API Key Quick Guide',
    fileName: 'bitget-api-key-quick-guide.md',
  },
  weex: {
    id: 'weex',
    title: 'WEEX API Key Quick Guide',
    fileName: 'weex-api-key-quick-guide.md',
  },
  mexc: {
    id: 'mexc',
    title: 'MEXC API Key Quick Guide',
    fileName: 'mexc-api-key-quick-guide.md',
  },
};
