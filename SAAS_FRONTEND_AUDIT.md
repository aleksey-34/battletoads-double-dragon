# SaaS Frontend UI Audit – File Locations and Issue Points

## Summary
This document maps the exact file locations, line numbers, and component names for the broken SaaS client-side UI elements identified in the search.

---

## 1. BACKTEST BUTTON HANDLERS

### 1.1 Strategy Card Backtest Button (Client-Facing)
**File:** [frontend/src/pages/SaaS.tsx](frontend/src/pages/SaaS.tsx#L8661)  
**Line:** 8661  
**Handler Name:** `openSaasBacktestFlow()`  
**Component Context:** Strategy Client product tile  
**UI Element:** Button labeled `{copy.openBacktest}`  

**Code location:**
```tsx
// Line 8661
<Button size="small" onClick={openSaasBacktestFlow} disabled={!strategyBacktestEnabled}>{copy.openBacktest}</Button>
```

**Handler Definition:** [Lines 5815-5821](frontend/src/pages/SaaS.tsx#L5815-L5821)
```tsx
const openSaasBacktestFlow = () => {
  if (selectedAdminReviewKind === 'algofund-ts') {
    openDraftTsBacktest();
    return;
  }
  openOfferBacktest(selectedAdminReviewOffer || reviewableSweepOffers[0] || null);
};
```

---

### 1.2 Algofund Card Backtest Button (Client-Facing)
**File:** [frontend/src/pages/SaaS.tsx](frontend/src/pages/SaaS.tsx#L9450)  
**Line:** 9450  
**Handler Name:** `openSaasBacktestFlow()`  
**Component Context:** Algofund product tile  
**UI Element:** Button labeled `{copy.openBacktest}`  

```tsx
// Line 9450
<Button size="small" onClick={openSaasBacktestFlow} disabled={!algofundBacktestEnabled}>{copy.openBacktest}</Button>
```

---

### 1.3 Offer Card Backtest (Admin - from Sweep Review Table)
**File:** [frontend/src/pages/SaaS.tsx](frontend/src/pages/SaaS.tsx#L7043)  
**Line:** 7043  
**Handler Name:** `openOfferBacktest(row)`  
**Component Context:** Sweep review candidates table (admin review tab)  
**UI Element:** Primary button labeled "Бэктест"  

```tsx
// Line 7043
<Button size="small" type="primary" onClick={() => openOfferBacktest(row)}>Бэктест</Button>
```

**Handler Definition:** [Lines 5604-5620](frontend/src/pages/SaaS.tsx#L5604-L5620)
```tsx
const openOfferBacktest = (offer?: typeof adminReviewOfferPool[number] | null) => {
  if (!offer) {
    messageApi.warning('Сначала выбери оффер из sweep-кандидатов');
    return;
  }
  openEmbeddedBacktest({
    kind: 'offer',
    title: `Бэктест оффера: ${offer.titleRu}`,
    description: 'Sweep-бэктест карточки из последнего свепа. Регулируй риск и частоту, проверяй метрики/equity и решай: отправить на витрину или закрыть.',
    offerId: String(offer.offerId || ''),
    offerPublished: Boolean(offer.published),
  });
};
```

---

## 2. OFFERS PAGE BACKTEST LOGIC & ERROR MESSAGE

### 2.1 Backend Error – "No offers resolved for sweep backtest preview"
**File:** [backend/src/saas/service.ts](backend/src/saas/service.ts#L5123)  
**Line:** 5123  
**Error Context:** Function `buildSweepBacktestPreviewRequest()`  

```typescript
// Line 5123
throw new Error('No offers resolved for sweep backtest preview');
```

**Full context:** [Lines 5110-5130](backend/src/saas/service.ts#L5110-L5130)
This error is thrown when the backend cannot resolve any offers from the sweep context or catalog for a backtest preview request. Triggers when:
- Catalog is unavailable
- Selected offer IDs cannot be resolved
- TS sweep member list yields no valid offers

**Related frontend handler:** [Lines 5185-5248](frontend/src/pages/SaaS.tsx#L5185-L5248)
```tsx
const runAdminSweepBacktestPreview = async (
  context?: SaasBacktestContext | null,
  options?: { preferRealBacktest?: boolean; settingsOverride?: Partial<BacktestCardSettings> }
) => {
  // ... implementation ...
  
  try {
    const response = await axios.post<AdminSweepBacktestPreviewResponse>('/api/saas/admin/sweep-backtest-preview', {
      kind: targetContext.kind,
      setKey: targetContext.setKey,
      systemName: targetContext.systemName,
      offerId: targetContext.offerId,
      offerIds: targetContext.offerIds,
      // ... more fields ...
    });
    // ... success handling ...
  } catch (error: any) {
    if (requestSeq !== backtestRequestSeqRef.current) {
      return;
    }
    const errorMessage = String(error?.response?.data?.error || error?.message || '');
    setAdminSweepBacktestResult(null);
    messageApi.error(errorMessage || 'Не удалось построить sweep backtest preview');
  }
}
```

---

## 3. EDIT BUTTON FUNCTIONALITY

### 3.1 Edit Button in Published Offers Storefront Table
**File:** [frontend/src/pages/SaaS.tsx](frontend/src/pages/SaaS.tsx#L7036-L7042)  
**Lines:** 7036-7042  
**Component Context:** "Витрина оферов клиентов стратегий" (Strategy Client Offers Storefront)  
**Button Label:** "Редактировать" (Edit)  
**Current Status:** NO-OP – only updates state selections  

```tsx
// Lines 7036-7042
<Button
  size="small"
  onClick={() => {
    setSelectedAdminReviewKind('offer');
    setSelectedAdminReviewOfferId(String(row.offerId));
  }}
>
  Редактировать
</Button>
```

**Issue:** 
- Click handler only selects the offer for review (`setSelectedAdminReviewKind('offer')`)
- Does NOT open an edit modal or form
- Shifts UI to display the selected offer in the "Выбрана карточка" section on the right (lines 7170-7218)
- No actual edit fields or form present

**Related UI Section:** [Lines 7170-7218](frontend/src/pages/SaaS.tsx#L7170-L7218)
- Shows offer details in `<Descriptions>` (read-only)
- Has buttons for "На витрину" (Publish), "Открыть бэктест оффера" (Open backtest), "Снять с витрины" (Unpublish)
- No edit capability present

---

## 4. GENERATE LOGIN LINK BUTTON & FORM FIELD

### 4.1 Strategy Client – Create Magic Link Button
**File:** [frontend/src/pages/SaaS.tsx](frontend/src/pages/SaaS.tsx#L8653-L8655)  
**Lines:** 8653-8655  
**Component Context:** Strategy Client admin workspace  
**Button Label:** `{copy.createMagicLink}` (Russian: "Сгенерировать ссылку входа")  

```tsx
// Lines 8653-8655
<Button onClick={() => void createStrategyMagicLink()} loading={actionLoading === 'strategy-magic-link'}>
  {copy.createMagicLink}
</Button>
```

**Handler Definition:** [Lines 4693-4702](frontend/src/pages/SaaS.tsx#L4693-L4702)
```tsx
const createStrategyMagicLink = async () => {
  if (!strategyTenantId) return;
  setActionLoading('strategy-magic-link');
  try {
    const response = await axios.post<ClientMagicLinkResponse>(`/api/saas/admin/tenants/${strategyTenantId}/magic-link`);
    setStrategyMagicLink(response.data);
    messageApi.success(copy.magicLinkReady);
  } catch (error: any) {
    messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to create magic link'));
  } finally {
    setActionLoading('');
  }
};
```

### 4.2 Generated Login Link Display Field
**File:** [frontend/src/pages/SaaS.tsx](frontend/src/pages/SaaS.tsx#L8656-L8664)  
**Lines:** 8656-8664  
**Component Type:** `<Alert>` with description  
**Display Logic:** Conditional on `strategyMagicLink` state  

```tsx
// Lines 8656-8664
{strategyMagicLink ? (
  <Alert
    style={{ marginTop: 8 }}
    type="info"
    showIcon
    message={copy.magicLinkReady}
    description={
      <>
        <div><a href={strategyMagicLink.loginUrl} target="_blank" rel="noreferrer">{strategyMagicLink.loginUrl}</a></div>
        <div>{copy.magicLinkExpires}: {new Date(strategyMagicLink.expiresAt).toLocaleString()}</div>
      </>
    }
  />
) : null}
```

**Type Definition:** [Lines 820-824](frontend/src/pages/SaaS.tsx#L820-L824)
```tsx
type ClientMagicLinkResponse = {
  tenantId?: number;
  loginUrl: string;
  expiresAt: string;
};
```

**i18n Keys:**
- `copy.createMagicLink` = Line 1244 (RU), Line 1361 (EN)
- `copy.magicLinkReady` = Line 1245 (RU), Line 1362 (EN)
- `copy.magicLinkExpires` = Line 1246 (RU), Line 1363 (EN)

### 4.3 Algofund Client – Generate Magic Link
**File:** [frontend/src/pages/SaaS.tsx](frontend/src/pages/SaaS.tsx#L9493)  
**Parallel Implementation:** Similar button + handler for algofund tenants
- Handler: `createAlgofundMagicLink()` (lines not explicitly shown, similar pattern)
- Display: [Lines 9483](frontend/src/pages/SaaS.tsx#L9483) for algofund magic link URL

---

## 5. VITRINE VISIBILITY FLAG DISPLAY

### 5.1 Published Status Tag in Offer Details
**File:** [frontend/src/pages/SaaS.tsx](frontend/src/pages/SaaS.tsx#L7190-7196)  
**Lines:** 7190-7196  
**Component Context:** Selected offer review section (right panel)  
**Display Logic:** Shows conditional tag based on `selectedAdminReviewOffer.published`  

```tsx
// Lines 7190-7196
<Space wrap>
  <Tag color={selectedAdminReviewOffer.published ? 'success' : 'processing'}>
    {selectedAdminReviewOffer.published ? 'on storefront' : 'not on storefront'}
  </Tag>
  <Tag color="blue">offer #{selectedAdminReviewOffer.offerId}</Tag>
  <Tag>{selectedAdminReviewOffer.mode.toUpperCase()}</Tag>
  <Tag>{selectedAdminReviewOffer.market}</Tag>
</Space>
```

### 5.2 Published Flag in Offers Table
**File:** [frontend/src/pages/SaaS.tsx](frontend/src/pages/SaaS.tsx#L7258-7280)  
**Lines:** 7258-7280 (table data source)  
**Component:** Published storefront offers table  

The table displays only `publishedStorefrontOffers`:
```tsx
// Line 2540
const publishedStorefrontOffers = useMemo(() => offerStoreOffers.filter((offer) => Boolean(offer.published)), [offerStoreOffers]);

// Line 7258
dataSource={publishedStorefrontOffers}
```

### 5.3 Publish/Unpublish Button (Vitrine Control)
**File:** [frontend/src/pages/SaaS.tsx](frontend/src/pages/SaaS.tsx#L7204-7211)  
**Lines:** 7204-7211  
**Component Context:** Selected offer action buttons  

```tsx
// Line 7204-7206
<Button
  type="primary"
  size="small"
  loading={actionLoading === `offer-store:${String(selectedAdminReviewOffer.offerId)}`}
  onClick={() => void toggleOfferPublished(String(selectedAdminReviewOffer.offerId), true)}
>
  {selectedAdminReviewOffer.published ? 'Обновить витрину' : 'На витрину'}
</Button>

// Line 7211
{selectedAdminReviewOffer.published ? <Button size="small" danger onClick={() => void openUnpublishWizard(String(selectedAdminReviewOffer.offerId))}>Снять с витрины</Button> : null}
```

**Handler:** [Lines 3282-3301](frontend/src/pages/SaaS.tsx#L3282-L3301)
```tsx
const toggleOfferPublished = async (offerId: string, published: boolean) => {
  // ... implementation that PATCHes /api/saas/admin/offer-store with publishedOfferIds
};
```

### 5.4 Vitrine Visibility in Strategy Card UI
**File:** [frontend/src/pages/SaaS.tsx](frontend/src/pages/SaaS.tsx#L8630-8640)  
**Lines:** 8630-8640  
**Component Context:** Storefront vitrine TS visual summary  
**Display:** Shows count of published TS cards and connected clients  

```tsx
// Card title area shows vitrine status tags with counts
<Tag color="processing">storefront offers: {publishedStorefrontOffers.length}</Tag>
```

---

## 6. SUMMARY TABLE

| Element | File | Line(s) | Component Type | Status |
|---------|------|---------|-----------------|--------|
| Strategy backtest button | SaaS.tsx | 8661 | Button/onClick | Working |
| Algofund backtest button | SaaS.tsx | 9450 | Button/onClick | Working |
| Offer backtest (admin) | SaaS.tsx | 7043 | Button/onClick | Working |
| Handler: openSaasBacktestFlow | SaaS.tsx | 5815-5821 | Function | Working |
| Handler: openOfferBacktest | SaaS.tsx | 5604-5620 | Function | Working |
| Backend error message | service.ts | 5123 | Error throw | Present |
| Edit button (offers table) | SaaS.tsx | 7036-7042 | Button/onClick | **NO-OP** |
| Create magic link button | SaaS.tsx | 8653-8655 | Button/onClick | Working |
| Generated link display | SaaS.tsx | 8656-8664 | Alert component | Working |
| Published status tag | SaaS.tsx | 7190-7196 | Tag component | Working |
| Vitrine control button | SaaS.tsx | 7204-7211 | Button/onClick | Working |
| Vitrine offer count | SaaS.tsx | 7228 | Tag display | Working |

---

## 7. RELATED BACKEND ENDPOINTS

| Endpoint | Method | File | Handler | Purpose |
|----------|--------|------|---------|---------|
| `/api/saas/admin/sweep-backtest-preview` | POST | saasRoutes.ts | Line 283 | Sweep backtest preview |
| `/api/saas/admin/tenants/{id}/magic-link` | POST | saasRoutes.ts | N/A | Generate login links |
| `/api/saas/admin/offer-store` | PATCH | saasRoutes.ts | N/A | Update offer visibility |

---

## 8. KEY STATE VARIABLES

| State | Type | Used by | Lines |
|-------|------|---------|-------|
| `selectedAdminReviewOfferId` | string | Edit button | 7039 |
| `selectedAdminReviewKind` | 'offer' \| 'algofund-ts' | Edit button | 7038 |
| `strategyMagicLink` | ClientMagicLinkResponse \| null | Link display | 8656 |
| `algofundMagicLink` | ClientMagicLinkResponse \| null | Link display (algofund) | 9483 |
| `publishedStorefrontOffers` | Offer[] | Offers table | 7258 |
| `selectedAdminReviewOffer` | Offer \| null | Vitrine visibility display | 7190 |

