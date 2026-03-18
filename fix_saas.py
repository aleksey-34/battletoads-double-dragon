import re

content = open('frontend/src/pages/SaaS.tsx', encoding='utf-8').read()
original_len = len(content)

# 1. Add Modal to antd imports
content = content.replace(
    "  Tag,\n  Typography,\n} from 'antd';",
    "  Tag,\n  Typography,\n  Modal,\n} from 'antd';"
)

# 2. Add Copy type fields
content = content.replace(
    "  createMagicLink: string;\n  magicLinkReady: string;\n  magicLinkExpires: string;\n};",
    "  createMagicLink: string;\n  magicLinkReady: string;\n  magicLinkExpires: string;\n  createClient: string;\n  createClientTitle: string;\n  createClientSuccess: string;\n};"
)

# 3. Add copy strings in ru
content = content.replace(
    "    magicLinkExpires: '\u0414\u0435\u0439\u0441\u0442\u0432\u0438\u0442\u0435\u043b\u044c\u043d\u0430 \u0434\u043e',\n  },\n  en: {",
    "    magicLinkExpires: '\u0414\u0435\u0439\u0441\u0442\u0432\u0438\u0442\u0435\u043b\u044c\u043d\u0430 \u0434\u043e',\n    createClient: '\u0421\u043e\u0437\u0434\u0430\u0442\u044c \u043a\u043b\u0438\u0435\u043d\u0442\u0430',\n    createClientTitle: '\u041d\u043e\u0432\u044b\u0439 \u043a\u043b\u0438\u0435\u043d\u0442',\n    createClientSuccess: '\u041a\u043b\u0438\u0435\u043d\u0442 \u0441\u043e\u0437\u0434\u0430\u043d',\n  },\n  en: {"
)

# 4. Add copy strings in en
content = content.replace(
    "    magicLinkExpires: 'Expires at',\n  },\n  tr: {",
    "    magicLinkExpires: 'Expires at',\n    createClient: 'Create client',\n    createClientTitle: 'New client',\n    createClientSuccess: 'Client created',\n  },\n  tr: {"
)

# 5. Add copy strings in tr
content = content.replace(
    "    magicLinkExpires: 'Son kullanim',\n  },\n};",
    "    magicLinkExpires: 'Son kullanim',\n    createClient: 'Musteri olustur',\n    createClientTitle: 'Yeni musteri',\n    createClientSuccess: 'Musteri olusturuldu',\n  },\n};"
)

# 6. Add state vars for create tenant modal (after algofundTenantPlanCode state)
content = content.replace(
    "  const [algofundTenantPlanCode, setAlgofundTenantPlanCode] = useState('');",
    "  const [algofundTenantPlanCode, setAlgofundTenantPlanCode] = useState('');\n  const [createTenantModalOpen, setCreateTenantModalOpen] = useState(false);\n  const [createTenantDisplayName, setCreateTenantDisplayName] = useState('');\n  const [createTenantProductMode, setCreateTenantProductMode] = useState<ProductMode>('strategy_client');\n  const [createTenantPlanCode, setCreateTenantPlanCode] = useState('');\n  const [createTenantApiKey, setCreateTenantApiKey] = useState('');\n  const [createTenantEmail, setCreateTenantEmail] = useState('');"
)

# 7. Add createTenantAdmin handler (after publishAdminTs function)
content = content.replace(
    "  const offerColumns: ColumnsType<CatalogOffer> = [",
    """  const createTenantAdmin = async () => {
    if (!createTenantDisplayName.trim() || !createTenantPlanCode) {
      messageApi.error('Display name and plan are required');
      return;
    }
    setActionLoading('createTenant');
    try {
      await axios.post('/api/saas/admin/tenants', {
        displayName: createTenantDisplayName,
        productMode: createTenantProductMode,
        planCode: createTenantPlanCode,
        assignedApiKeyName: createTenantApiKey || undefined,
        email: createTenantEmail || undefined,
        language,
      });
      messageApi.success(copy.createClientSuccess);
      setCreateTenantModalOpen(false);
      setCreateTenantDisplayName('');
      setCreateTenantProductMode('strategy_client');
      setCreateTenantPlanCode('');
      setCreateTenantApiKey('');
      setCreateTenantEmail('');
      await loadSummary();
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to create tenant'));
    } finally {
      setActionLoading('');
    }
  };

  const offerColumns: ColumnsType<CatalogOffer> = ["""
)

# 8. Add "Create client" button next to seed button
content = content.replace(
    "              {isAdminSurface ? <Button onClick={() => void seedDemoTenants()} loading={actionLoading === 'seed'}>{copy.seed}</Button> : null}",
    "              {isAdminSurface ? <Button onClick={() => void seedDemoTenants()} loading={actionLoading === 'seed'}>{copy.seed}</Button> : null}\n              {isAdminSurface ? <Button type=\"dashed\" onClick={() => setCreateTenantModalOpen(true)}>{copy.createClient}</Button> : null}"
)

# 9. Add Modal JSX before closing div
content = content.replace(
    "    </div>\n  );\n};",
    """      <Modal
        title={copy.createClientTitle}
        open={createTenantModalOpen}
        onCancel={() => setCreateTenantModalOpen(false)}
        onOk={() => void createTenantAdmin()}
        confirmLoading={actionLoading === 'createTenant'}
        okText={copy.createClient}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <div>
            <Text strong>{copy.displayName} *</Text>
            <Input style={{ marginTop: 4 }} value={createTenantDisplayName} onChange={(e) => setCreateTenantDisplayName(e.target.value)} placeholder="AlphaFund Client" />
          </div>
          <div>
            <Text strong>{copy.tenantMode} *</Text>
            <Select style={{ width: '100%', marginTop: 4 }} value={createTenantProductMode} onChange={setCreateTenantProductMode} options={[{ value: 'strategy_client', label: copy.strategyClient }, { value: 'algofund_client', label: copy.algofund }]} />
          </div>
          <div>
            <Text strong>{copy.plan} *</Text>
            <Select style={{ width: '100%', marginTop: 4 }} value={createTenantPlanCode || undefined} onChange={(v) => setCreateTenantPlanCode(v || '')} options={(summary?.plans || []).filter((p) => p.product_mode === createTenantProductMode).map((p) => ({ value: p.code, label: p.title }))} />
          </div>
          <div>
            <Text strong>{copy.apiKey}</Text>
            <Select allowClear style={{ width: '100%', marginTop: 4 }} value={createTenantApiKey || undefined} onChange={(v) => setCreateTenantApiKey(v || '')} options={apiKeyOptions} />
          </div>
          <div>
            <Text strong>Email</Text>
            <Input type="email" style={{ marginTop: 4 }} value={createTenantEmail} onChange={(e) => setCreateTenantEmail(e.target.value)} placeholder="client@example.com" />
          </div>
        </Space>
      </Modal>
    </div>
  );
};"""
)

# 10. Fix metric display priority: backend > chart-derived
# Algofund preview
content = content.replace(
    "formatMoney(algofundPreviewDerivedSummary?.finalEquity ?? algofundState.preview?.summary?.finalEquity)",
    "formatMoney(algofundState.preview?.summary?.finalEquity ?? algofundPreviewDerivedSummary?.finalEquity)"
)
content = content.replace(
    "formatPercent(algofundPreviewDerivedSummary?.totalReturnPercent ?? algofundState.preview?.summary?.totalReturnPercent)",
    "formatPercent(algofundState.preview?.summary?.totalReturnPercent ?? algofundPreviewDerivedSummary?.totalReturnPercent)"
)
content = content.replace(
    "formatPercent(algofundPreviewDerivedSummary?.maxDrawdownPercent ?? algofundState.preview?.summary?.maxDrawdownPercent)",
    "formatPercent(algofundState.preview?.summary?.maxDrawdownPercent ?? algofundPreviewDerivedSummary?.maxDrawdownPercent)"
)
# Publish preview
content = content.replace(
    "formatMoney(publishPreviewDerivedSummary?.finalEquity ?? publishResponse.preview.summary?.finalEquity)",
    "formatMoney(publishResponse.preview.summary?.finalEquity ?? publishPreviewDerivedSummary?.finalEquity)"
)
content = content.replace(
    "formatPercent(publishPreviewDerivedSummary?.totalReturnPercent ?? publishResponse.preview.summary?.totalReturnPercent)",
    "formatPercent(publishResponse.preview.summary?.totalReturnPercent ?? publishPreviewDerivedSummary?.totalReturnPercent)"
)
content = content.replace(
    "formatPercent(publishPreviewDerivedSummary?.maxDrawdownPercent ?? publishResponse.preview.summary?.maxDrawdownPercent)",
    "formatPercent(publishResponse.preview.summary?.maxDrawdownPercent ?? publishPreviewDerivedSummary?.maxDrawdownPercent)"
)
# Strategy selection preview
content = content.replace(
    "formatMoney(strategySelectionPreviewDerivedSummary?.finalEquity ?? (strategySelectionPreviewSummary as any)?.finalEquity)",
    "formatMoney((strategySelectionPreviewSummary as any)?.finalEquity ?? strategySelectionPreviewDerivedSummary?.finalEquity)"
)
content = content.replace(
    "formatPercent(strategySelectionPreviewDerivedSummary?.totalReturnPercent ?? (strategySelectionPreviewSummary as any)?.totalReturnPercent)",
    "formatPercent((strategySelectionPreviewSummary as any)?.totalReturnPercent ?? strategySelectionPreviewDerivedSummary?.totalReturnPercent)"
)
content = content.replace(
    "formatPercent(strategySelectionPreviewDerivedSummary?.maxDrawdownPercent ?? (strategySelectionPreviewSummary as any)?.maxDrawdownPercent)",
    "formatPercent((strategySelectionPreviewSummary as any)?.maxDrawdownPercent ?? strategySelectionPreviewDerivedSummary?.maxDrawdownPercent)"
)
# Strategy individual preview
content = content.replace(
    "formatMoney(strategyPreviewDerivedSummary?.finalEquity ?? (strategyPreviewSummary as any)?.finalEquity)",
    "formatMoney((strategyPreviewSummary as any)?.finalEquity ?? strategyPreviewDerivedSummary?.finalEquity)"
)
content = content.replace(
    "formatPercent(strategyPreviewDerivedSummary?.totalReturnPercent ?? (strategyPreviewSummary as any)?.totalReturnPercent ?? strategyPreviewMetrics?.ret)",
    "formatPercent((strategyPreviewSummary as any)?.totalReturnPercent ?? strategyPreviewDerivedSummary?.totalReturnPercent ?? strategyPreviewMetrics?.ret)"
)
content = content.replace(
    "formatPercent(strategyPreviewDerivedSummary?.maxDrawdownPercent ?? (strategyPreviewSummary as any)?.maxDrawdownPercent ?? strategyPreviewMetrics?.dd)",
    "formatPercent((strategyPreviewSummary as any)?.maxDrawdownPercent ?? strategyPreviewDerivedSummary?.maxDrawdownPercent ?? strategyPreviewMetrics?.dd)"
)

new_len = len(content)
print(f'Original: {original_len}, New: {new_len}, Delta: {new_len - original_len}')
print('Modal import:', '  Modal,' in content)
print('createClient type:', '  createClient: string;' in content)
print('ru createClient str:', "createClient: '\u0421\u043e\u0437\u0434\u0430\u0442\u044c" in content)
print('State vars added:', 'createTenantModalOpen' in content)
print('Handler added:', 'createTenantAdmin' in content)
print('Button added:', 'setCreateTenantModalOpen(true)' in content)
print('Modal JSX added:', 'createClientTitle' in content and 'onOk={() => void createTenantAdmin' in content)
print('Metric fix algofund:', 'algofundState.preview?.summary?.totalReturnPercent ?? algofundPreviewDerivedSummary' in content)
print('Metric fix publish:', 'publishResponse.preview.summary?.totalReturnPercent ?? publishPreviewDerivedSummary' in content)

open('frontend/src/pages/SaaS.tsx', 'w', encoding='utf-8').write(content)
print('Done - file saved')
