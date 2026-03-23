import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Button,
  Card,
  Col,
  Empty,
  Input,
  List,
  Row,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from 'antd';
import { useI18n } from '../i18n';

const { Title, Text, Paragraph } = Typography;

type AdminDocListItem = {
  relativePath: string;
  title: string;
  group: string;
  sizeBytes: number;
  updatedAt: string | null;
};

type AdminDocContent = AdminDocListItem & {
  content: string;
};

function formatBytes(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return '0 B';
  }

  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  const sizeKb = sizeBytes / 1024;
  if (sizeKb < 1024) {
    return `${sizeKb.toFixed(1)} KB`;
  }

  return `${(sizeKb / 1024).toFixed(1)} MB`;
}

export default function AdminDocs() {
  const { t } = useI18n();
  const [docs, setDocs] = useState<AdminDocListItem[]>([]);
  const [selectedPath, setSelectedPath] = useState<string>('');
  const [searchText, setSearchText] = useState('');
  const [selectedGroup, setSelectedGroup] = useState<string>('all');
  const [docsLoading, setDocsLoading] = useState(false);
  const [docLoading, setDocLoading] = useState(false);
  const [activeDoc, setActiveDoc] = useState<AdminDocContent | null>(null);

  const loadDocs = useCallback(async () => {
    setDocsLoading(true);
    try {
      const response = await axios.get('/api/admin/docs');
      const nextDocs = Array.isArray(response.data?.docs) ? response.data.docs as AdminDocListItem[] : [];
      setDocs(nextDocs);
      setSelectedPath((currentPath) => {
        if (currentPath && nextDocs.some((doc) => doc.relativePath === currentPath)) {
          return currentPath;
        }
        return nextDocs[0]?.relativePath || '';
      });
    } catch (error: any) {
      message.error(error?.response?.data?.error || t('docs.loadListError', 'Failed to load markdown docs'));
    } finally {
      setDocsLoading(false);
    }
  }, [t]);

  const loadDoc = useCallback(async (docPath: string) => {
    if (!docPath) {
      setActiveDoc(null);
      return;
    }

    setDocLoading(true);
    try {
      const response = await axios.get('/api/admin/docs/content', {
        params: {
          docPath,
        },
      });
      setActiveDoc(response.data?.doc || null);
    } catch (error: any) {
      setActiveDoc(null);
      message.error(error?.response?.data?.error || t('docs.loadContentError', 'Failed to load markdown document'));
    } finally {
      setDocLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadDocs();
  }, [loadDocs]);

  useEffect(() => {
    void loadDoc(selectedPath);
  }, [loadDoc, selectedPath]);

  const filteredDocs = useMemo(() => {
    const needle = searchText.trim().toLowerCase();
    return docs.filter((doc) => {
      if (selectedGroup !== 'all' && doc.group !== selectedGroup) {
        return false;
      }
      if (!needle) {
        return true;
      }
      return [doc.title, doc.relativePath, doc.group].some((value) => value.toLowerCase().includes(needle));
    });
  }, [docs, searchText, selectedGroup]);

  const docGroups = useMemo(() => {
    const counts = docs.reduce<Record<string, number>>((acc, item) => {
      acc[item.group] = (acc[item.group] || 0) + 1;
      return acc;
    }, {});

    return Object.entries(counts)
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([group, count]) => ({ group, count }));
  }, [docs]);

  const handleCopyPath = async () => {
    if (!activeDoc?.relativePath || !navigator?.clipboard) {
      return;
    }

    await navigator.clipboard.writeText(activeDoc.relativePath);
    message.success(t('docs.pathCopied', 'Path copied'));
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Title level={2} style={{ marginBottom: 4 }}>{t('docs.title', 'Markdown Docs')}</Title>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {t('docs.subtitle', 'Admin-only library of repository markdown documents under the current dashboard password.')}
        </Paragraph>
      </div>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={8}>
          <Card
            title={t('docs.library', 'Library')}
            extra={<Button onClick={() => void loadDocs()} loading={docsLoading}>{t('common.refresh', 'Refresh')}</Button>}
            bodyStyle={{ paddingBottom: 12 }}
          >
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Input
                allowClear
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                placeholder={t('docs.search', 'Search by title or path')}
              />
              <Space wrap>
                <Tag
                  color={selectedGroup === 'all' ? 'processing' : 'default'}
                  onClick={() => setSelectedGroup('all')}
                  style={{ cursor: 'pointer' }}
                >
                  all ({docs.length})
                </Tag>
                {docGroups.map((item) => (
                  <Tag
                    key={item.group}
                    color={selectedGroup === item.group ? 'processing' : 'default'}
                    onClick={() => setSelectedGroup(item.group)}
                    style={{ cursor: 'pointer' }}
                  >
                    {item.group} ({item.count})
                  </Tag>
                ))}
              </Space>
              <Text type="secondary">{t('docs.count', '{count} docs', { count: filteredDocs.length })}</Text>
              <List
                bordered
                loading={docsLoading}
                locale={{ emptyText: <Empty description={t('docs.empty', 'No markdown docs found')} /> }}
                dataSource={filteredDocs}
                renderItem={(item) => (
                  <List.Item
                    onClick={() => setSelectedPath(item.relativePath)}
                    style={{
                      cursor: 'pointer',
                      background: item.relativePath === selectedPath ? '#f0f5ff' : undefined,
                      borderRadius: 8,
                      margin: '4px 8px',
                      paddingInline: 12,
                    }}
                  >
                    <Space direction="vertical" size={2} style={{ width: '100%' }}>
                      <Space wrap>
                        <Text strong>{item.title}</Text>
                        <Tag>{item.group}</Tag>
                      </Space>
                      <Text type="secondary" style={{ fontSize: 12 }}>{item.relativePath}</Text>
                    </Space>
                  </List.Item>
                )}
              />
            </Space>
          </Card>
        </Col>
        <Col xs={24} lg={16}>
          <Card
            title={activeDoc?.title || t('docs.viewer', 'Viewer')}
            extra={
              <Space>
                <Button onClick={() => void loadDoc(selectedPath)} disabled={!selectedPath} loading={docLoading}>
                  {t('docs.reloadDoc', 'Reload doc')}
                </Button>
                <Button onClick={() => void handleCopyPath()} disabled={!activeDoc?.relativePath || !navigator?.clipboard}>
                  {t('docs.copyPath', 'Copy path')}
                </Button>
              </Space>
            }
          >
            {!selectedPath ? (
              <Empty description={t('docs.selectPrompt', 'Select a markdown file')} />
            ) : docLoading ? (
              <div style={{ padding: '48px 0', textAlign: 'center' }}>
                <Spin />
              </div>
            ) : !activeDoc ? (
              <Empty description={t('docs.unavailable', 'Document unavailable')} />
            ) : (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <Space wrap>
                  <Tag color="blue">{activeDoc.group}</Tag>
                  <Text type="secondary">{t('docs.pathLabel', 'Path')}: {activeDoc.relativePath}</Text>
                </Space>
                <Space wrap>
                  <Text type="secondary">{t('docs.updatedLabel', 'Updated')}: {activeDoc.updatedAt || t('common.unknown', 'Unknown')}</Text>
                  <Text type="secondary">{t('docs.sizeLabel', 'Size')}: {formatBytes(activeDoc.sizeBytes)}</Text>
                </Space>
                <Card size="small" className="docs-markdown-frame">
                  <div className="docs-markdown-body">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
                        code: ({ className, children, ...props }) => <code className={`docs-code-block ${className || ''}`.trim()} {...props}>{children}</code>,
                        table: ({ node, ...props }) => <div className="docs-table-wrap"><table {...props} /></div>,
                        blockquote: ({ node, ...props }) => <blockquote className="docs-blockquote" {...props} />,
                      }}
                    >
                      {activeDoc.content}
                    </ReactMarkdown>
                  </div>
                </Card>
              </Space>
            )}
          </Card>
        </Col>
      </Row>
    </Space>
  );
}