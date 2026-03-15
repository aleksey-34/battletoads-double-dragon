import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import axios from 'axios';
import SaaS, { hydrateStrategyPreview } from './SaaS';
import { I18nProvider } from '../i18n';

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
    defaults: { headers: { common: {} } },
    interceptors: {
      request: { use: jest.fn() },
      response: { use: jest.fn() },
    },
  },
}));
jest.mock('antd', () => {
  const React = require('react');
  const SimpleDiv = ({ children, ...props }: any) => React.createElement('div', props, children);
  const SimpleSpan = ({ children, ...props }: any) => React.createElement('span', props, children);
  const Button = ({ children, onClick, disabled, ...props }: any) => React.createElement('button', { ...props, disabled, onClick }, children);
  const Checkbox = ({ checked, onChange, ...props }: any) => React.createElement('input', {
    ...props,
    type: 'checkbox',
    checked: Boolean(checked),
    onChange: (event: any) => onChange?.({ target: { checked: event.target.checked } }),
  });
  const Input = ({ value, onChange, ...props }: any) => React.createElement('input', {
    ...props,
    value: value ?? '',
    onChange,
  });
  Input.TextArea = ({ value, onChange, ...props }: any) => React.createElement('textarea', {
    ...props,
    value: value ?? '',
    onChange,
  });
  const InputNumber = ({ value, onChange, min, max, step, ...props }: any) => React.createElement('input', {
    ...props,
    type: 'number',
    value: value ?? '',
    min,
    max,
    step,
    onChange: (event: any) => onChange?.(event.target.value === '' ? null : Number(event.target.value)),
  });
  const Select = ({ value, onChange, options = [], ...props }: any) => React.createElement(
    'select',
    {
      ...props,
      value: value ?? '',
      onChange: (event: any) => onChange?.(event.target.value),
    },
    options.map((option: any) => React.createElement('option', { key: String(option.value), value: option.value }, option.label))
  );
  const Slider = ({ value, onChange, min = 0, max = 100, step = 1, ...props }: any) => React.createElement('input', {
    ...props,
    type: 'range',
    value: value ?? 0,
    min,
    max,
    step,
    onChange: (event: any) => onChange?.(Number(event.target.value)),
  });
  const Descriptions: any = ({ children }: any) => React.createElement('div', null, children);
  Descriptions.Item = ({ label, children }: any) => React.createElement('div', null, React.createElement('span', null, label), children);
  const List: any = ({ dataSource = [], renderItem, locale }: any) => React.createElement(
    'div',
    null,
    dataSource.length > 0
      ? dataSource.map((item: any, index: number) => React.createElement(React.Fragment, { key: index }, renderItem(item, index)))
      : locale?.emptyText || null
  );
  List.Item = ({ children }: any) => React.createElement('div', null, children);
  const Table = ({ dataSource = [] }: any) => React.createElement('div', { 'data-testid': 'table' }, String(dataSource.length));
  const Tabs = ({ items = [], activeKey }: any) => React.createElement('div', null, items.find((item: any) => item.key === activeKey)?.children || null);
  const messageApi = {
    success: jest.fn(),
    error: jest.fn(),
    warning: jest.fn(),
  };

  return {
    Alert: ({ message }: any) => React.createElement('div', null, message),
    Button,
    Card: ({ title, extra, children }: any) => React.createElement('div', null, title, extra, children),
    Checkbox,
    Row: SimpleDiv,
    Col: SimpleDiv,
    Descriptions,
    Empty: ({ description }: any) => React.createElement('div', null, description),
    Input,
    InputNumber,
    List,
    Select,
    Slider,
    Space: SimpleDiv,
    Spin: ({ children }: any) => React.createElement('div', null, children),
    Statistic: ({ title, value, suffix }: any) => React.createElement('div', null, title, value, suffix),
    Table,
    Tabs,
    Tag: SimpleSpan,
    Typography: {
      Paragraph: SimpleDiv,
      Text: SimpleSpan,
      Title: SimpleDiv,
    },
    message: {
      useMessage: () => [messageApi, React.createElement('div', { key: 'message-context' })],
    },
  };
});
jest.mock('../components/ChartComponent', () => () => <div data-testid="chart-component" />);

const mockedAxios = axios as jest.Mocked<typeof axios>;

const offer = {
  offerId: 'offer-1',
  titleRu: 'Offer One',
  descriptionRu: 'Legacy-safe offer',
  strategy: {
    id: 101,
    name: 'DD_BattleToads',
    type: 'DD_BattleToads',
    mode: 'mono' as const,
    market: 'BTCUSDT',
  },
  metrics: {
    ret: 12.4,
    pf: 1.8,
    dd: 3.2,
    wr: 54.1,
    trades: 42,
    score: 8.7,
  },
  equity: {
    points: [{ time: 1710000000, equity: 10000 }],
    summary: {
      totalReturnPercent: 12.4,
      maxDrawdownPercent: 3.2,
      profitFactor: 1.8,
      tradesCount: 42,
    },
  },
};

const plan = {
  id: 1,
  code: 'strategy-basic',
  title: 'Strategy Basic',
  product_mode: 'strategy_client' as const,
  price_usdt: 20,
  max_deposit_total: 1000,
  risk_cap_max: 1,
  max_strategies_total: 3,
  allow_ts_start_stop_requests: 1,
};

const legacyPreviewPayload = {
  offerId: 'offer-1',
  preset: {
    strategyId: 101,
    strategyName: 'DD_BattleToads',
    score: 8.7,
    metrics: {
      ret: 12.4,
      pf: 1.8,
      dd: 3.2,
      wr: 54.1,
      trades: 42,
    },
  },
  controls: {
    riskScore: 5,
    tradeFrequencyScore: 5,
    riskLevel: 'medium',
    tradeFrequencyLevel: 'medium',
  },
  period: {
    dateFrom: '2025-01-01T00:00:00Z',
    dateTo: '2026-03-14T00:00:00Z',
    interval: '4h',
  },
  preview: {
    source: 'catalog_cache',
    summary: {
      totalReturnPercent: 12.4,
      maxDrawdownPercent: 3.2,
      profitFactor: 1.8,
      tradesCount: 42,
    },
    equity: {
      points: [{ time: 1710000000, equity: 10000 }],
      summary: {
        totalReturnPercent: 12.4,
      },
    },
  },
};

const summaryResponse = {
  sourceFiles: {
    latestCatalogPath: 'results/catalog.json',
    latestSweepPath: 'results/sweep.json',
  },
  catalog: null,
  sweepSummary: null,
  recommendedSets: {},
  tenants: [
    {
      tenant: {
        id: 1,
        slug: 'client-bot-01',
        display_name: 'Client Bot 01',
        product_mode: 'strategy_client' as const,
        status: 'active',
        preferred_language: 'ru',
        assigned_api_key_name: 'BTDD_M1',
      },
      plan,
      strategyProfile: null,
      algofundProfile: null,
      monitoring: null,
    },
  ],
  plans: [plan],
  apiKeys: ['BTDD_M1'],
};

const strategyClientState = {
  tenant: summaryResponse.tenants[0].tenant,
  plan,
  profile: {
    selectedOfferIds: ['offer-1'],
    latestPreview: legacyPreviewPayload,
    risk_level: 'medium',
    trade_frequency_level: 'medium',
    requested_enabled: 0,
    actual_enabled: 0,
    assigned_api_key_name: 'BTDD_M1',
  },
  catalog: null,
  offers: [offer],
  recommendedSets: {},
};

describe('SaaS strategy preview hardening', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockedAxios.get.mockReset();
    mockedAxios.post.mockReset();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('hydrates a legacy preview payload using offerId', () => {
    const hydrated = hydrateStrategyPreview(legacyPreviewPayload, [offer]);

    expect(hydrated?.offer?.titleRu).toBe('Offer One');
    expect(hydrated?.offerId).toBe('offer-1');
  });

  it('renders strategy-client surface without crashing when cached preview lacks embedded offer', async () => {
    mockedAxios.get.mockImplementation(async (url) => {
      if (url === '/api/saas/admin/summary') {
        return { data: summaryResponse };
      }

      if (url === '/api/saas/strategy-clients/1') {
        return { data: strategyClientState };
      }

      throw new Error(`Unexpected GET ${String(url)}`);
    });

    mockedAxios.post.mockResolvedValue({
      data: {
        ...legacyPreviewPayload,
        offer,
      },
    });

    render(
      <I18nProvider>
        <SaaS initialTab="strategy-client" surfaceMode="strategy-client" />
      </I18nProvider>
    );

    await screen.findByText('Client Bot 01');

    await act(async () => {
      jest.advanceTimersByTime(400);
    });

    await waitFor(() => {
      expect(mockedAxios.post).toHaveBeenCalledWith(
        '/api/saas/strategy-clients/1/preview',
        expect.objectContaining({ offerId: 'offer-1' })
      );
    });

    expect(screen.getAllByText('Offer One').length).toBeGreaterThan(0);
  });
});