import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Space, Spin, Tag, Typography, message } from 'antd';
import { useParams } from 'react-router-dom';
import MonitoringChartPanel, {
  ChartPeriodDays,
  MonitoringPeriodStats,
  MonitoringSnapshot,
  MonitoringTradeFrequencyPoint,
  MonitoringTradeRow,
} from '../components/MonitoringChartPanel';
import { buildPublicPortfolioUrl, copyPublicPortfolioLink } from '../utils/portfolioLinks';

type PublicPortfolioPayload = {
  success: boolean;
  generatedAt?: string;
  cacheTtlSec?: number;
  portfolio?: {
    slug?: string;
    displayName?: string;
    description?: string;
    productMode?: string;
    publishedSystemName?: string;
    apiKeyName?: string;
  };
  points?: MonitoringSnapshot[];
  latest?: MonitoringSnapshot | null;
  periodStats?: MonitoringPeriodStats | null;
  trades?: MonitoringTradeRow[];
  tradeFrequency?: MonitoringTradeFrequencyPoint[];
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
      setErrorText((error as Error)?.message || 'Не удалось загрузить портфель');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(days);
  }, [slug, days]);

  const portfolioSlug = String(payload?.portfolio?.slug || slug).trim();
  const publicUrl = portfolioSlug ? buildPublicPortfolioUrl(portfolioSlug) : '';

  const title = useMemo(() => {
    const displayName = String(payload?.portfolio?.displayName || '').trim();
    return displayName || portfolioSlug || 'Portfolio';
  }, [payload?.portfolio?.displayName, portfolioSlug]);

  const description = String(payload?.portfolio?.description || '').trim();

  const rawPoints = payload?.points;
  const rawTrades = payload?.trades;
  const rawFreq = payload?.tradeFrequency;
  const snapshots: MonitoringSnapshot[] = Array.isArray(rawPoints) ? rawPoints : [];
  const trades: MonitoringTradeRow[] = Array.isArray(rawTrades) ? rawTrades : [];
  const tradeFrequency: MonitoringTradeFrequencyPoint[] = Array.isArray(rawFreq) ? rawFreq : [];

  const handleCopyLink = async () => {
    if (!portfolioSlug) return;
    const ok = await copyPublicPortfolioLink(portfolioSlug);
    if (ok) {
      message.success('Ссылка скопирована');
    } else {
      message.error('Не удалось скопировать ссылку');
    }
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--ant-color-bg-base)', padding: 24 }}>
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Space style={{ justifyContent: 'space-between', width: '100%' }} wrap>
            <div>
              <Typography.Title level={2} style={{ margin: 0 }}>{title}</Typography.Title>
              {description ? (
                <Typography.Paragraph style={{ marginTop: 8, marginBottom: 4, whiteSpace: 'pre-wrap' }}>
                  {description}
                </Typography.Paragraph>
              ) : null}
              <Typography.Text type="secondary">
                Публичная витрина счёта. Данные обновляются из локальных снимков мониторинга, кэш 1 час.
              </Typography.Text>
            </div>
            <Space wrap>
              {payload?.portfolio?.publishedSystemName ? (
                <Tag color="gold">{payload.portfolio.publishedSystemName}</Tag>
              ) : null}
              {payload?.generatedAt ? (
                <Tag color="blue">Обновлено: {new Date(payload.generatedAt).toLocaleString('ru-RU')}</Tag>
              ) : null}
            </Space>
          </Space>

          <Card>
            <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
              <Space direction="vertical" size={4}>
                <Space wrap>
                  <Tag color="purple">Slug: {portfolioSlug || '—'}</Tag>
                  {payload?.cacheTtlSec ? (
                    <Tag color="orange">Кэш {Math.round(payload.cacheTtlSec / 60)} мин</Tag>
                  ) : null}
                </Space>
                {publicUrl ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12, wordBreak: 'break-all' }}>
                    {publicUrl}
                  </Typography.Text>
                ) : null}
              </Space>
              <Space wrap>
                <Button onClick={() => void handleCopyLink()} disabled={!portfolioSlug}>
                  Скопировать ссылку
                </Button>
                <Button onClick={() => void load(days)} loading={loading}>
                  Обновить
                </Button>
              </Space>
            </Space>
          </Card>

          {errorText ? <Alert type="error" showIcon message={errorText} /> : null}

          <Card styles={{ body: { padding: 16 } }}>
            <Spin spinning={loading}>
              <MonitoringChartPanel
                snapshots={snapshots}
                chartDays={days}
                onChartDaysChange={setDays}
                periodStats={payload?.periodStats || null}
                trades={trades}
                tradeFrequency={tradeFrequency}
                trades24h={Number(payload?.tradeStats?.trades24h || 0)}
                lastTradeAt={payload?.tradeStats?.lastTradeAt || null}
                loading={loading}
                currencyLabel="USD"
              />
            </Spin>
          </Card>

          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
            Доходность считается по изменению equity за выбранный период. Депозиты и выводы пока не вычитаются.
          </Typography.Paragraph>
        </Space>
      </div>
    </div>
  );
};

export default PublicPortfolioPage;
