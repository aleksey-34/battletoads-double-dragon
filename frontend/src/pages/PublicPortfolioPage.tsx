import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Space, Spin, Tag, Typography } from 'antd';
import { useParams } from 'react-router-dom';
import MonitoringChartPanel, {
  ChartPeriodDays,
  MonitoringPeriodStats,
  MonitoringSnapshot,
  MonitoringTradeRow,
} from '../components/MonitoringChartPanel';

type PublicPortfolioPayload = {
  success: boolean;
  generatedAt?: string;
  cacheTtlSec?: number;
  portfolio?: {
    slug?: string;
    displayName?: string;
    productMode?: string;
    publishedSystemName?: string;
    apiKeyName?: string;
  };
  points?: MonitoringSnapshot[];
  latest?: MonitoringSnapshot | null;
  periodStats?: MonitoringPeriodStats | null;
  trades?: MonitoringTradeRow[];
  tradeStats?: {
    trades24h?: number;
    lastTradeAt?: string | null;
  };
};

const PublicPortfolioPage: React.FC = () => {
  const { slug = '' } = useParams();
  const [days, setDays] = useState<ChartPeriodDays>(30);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [payload, setPayload] = useState<PublicPortfolioPayload | null>(null);

  const load = async (nextDays: ChartPeriodDays) => {
    if (!slug) return;
    setLoading(true);
    setErrorText('');
    try {
      const params = new URLSearchParams();
      if (nextDays === 0) {
        params.set('all', '1');
      } else if (nextDays > 1) {
        params.set('days', String(nextDays));
      }
      const response = await fetch(`/api/public/portfolio/${encodeURIComponent(slug)}?${params.toString()}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String(json?.error || `HTTP ${response.status}`));
      }
      setPayload(json);
    } catch (error) {
      setPayload(null);
      setErrorText((error as Error)?.message || 'Failed to load portfolio');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(days);
  }, [slug, days]);

  const title = useMemo(() => {
    const displayName = String(payload?.portfolio?.displayName || '').trim();
    const safeSlug = String(payload?.portfolio?.slug || slug).trim();
    return displayName || safeSlug || 'Portfolio';
  }, [payload?.portfolio?.displayName, payload?.portfolio?.slug, slug]);

  const rawPoints = payload?.points;
  const rawTrades = payload?.trades;
  const snapshots: MonitoringSnapshot[] = Array.isArray(rawPoints) ? rawPoints : [];
  const trades: MonitoringTradeRow[] = Array.isArray(rawTrades) ? rawTrades : [];

  return (
    <div style={{ minHeight: '100vh', background: 'var(--ant-color-bg-base)', padding: 24 }}>
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Space style={{ justifyContent: 'space-between', width: '100%' }} wrap>
            <div>
              <Typography.Title level={2} style={{ margin: 0 }}>{title}</Typography.Title>
              <Typography.Text type="secondary">
                Публичная страница портфеля. Данные кешируются на 1 час и строятся по локальным снимкам мониторинга.
              </Typography.Text>
            </div>
            <Space wrap>
              {payload?.portfolio?.publishedSystemName ? (
                <Tag color="gold">{payload.portfolio.publishedSystemName}</Tag>
              ) : null}
              {payload?.portfolio?.productMode ? (
                <Tag>{payload.portfolio.productMode}</Tag>
              ) : null}
              {payload?.generatedAt ? (
                <Tag color="blue">Обновлено: {new Date(payload.generatedAt).toLocaleString('ru-RU')}</Tag>
              ) : null}
            </Space>
          </Space>

          <Card>
            <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
              <Space wrap>
                <Tag color="purple">Slug: {payload?.portfolio?.slug || slug}</Tag>
                {payload?.cacheTtlSec ? (
                  <Tag color="orange">Кэш {Math.round(payload.cacheTtlSec / 60)} мин</Tag>
                ) : null}
              </Space>
              <Button onClick={() => void load(days)} loading={loading}>Обновить</Button>
            </Space>
          </Card>

          {errorText ? <Alert type="error" showIcon message={errorText} /> : null}

          <Card bodyStyle={{ padding: 16 }}>
            <Spin spinning={loading}>
              <MonitoringChartPanel
                snapshots={snapshots}
                chartDays={days}
                onChartDaysChange={setDays}
                periodStats={payload?.periodStats || null}
                trades={trades}
                trades24h={Number(payload?.tradeStats?.trades24h || 0)}
                lastTradeAt={payload?.tradeStats?.lastTradeAt || null}
                loading={loading}
                currencyLabel="USD"
              />
            </Spin>
          </Card>
        </Space>
      </div>
    </div>
  );
};

export default PublicPortfolioPage;
