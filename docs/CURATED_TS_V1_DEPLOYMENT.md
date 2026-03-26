# HIGH-TRADE CURATED TS v1 Deployment Guide

**Status**: Ready for VPS Deployment  
**Generated**: 2026-03-26T09:45:00Z  
**Source**: Sweep artifacts from 2026-03-12 to 2026-03-23  
**Target API Key**: `BTDD_D1` (default, configurable)

---

## 1. What is Curated TS v1?

A **production-ready 5-member portfolio** optimized for high-frequency trading with acceptable profit factor and drawdown metrics:

### Members (Aggregate Stats)
- **Total Trades**: 3,400
- **Avg Profit Factor**: 1.01
- **Avg Return %**: 0.072
- **Avg Drawdown %**: 1.358
- **Trades/Day**: ~7.5

### Selection Criteria
- Minimum PF: 1.0 (soft threshold vs 1.02 standard)
- Maximum DD: 35% (soft threshold vs 28% standard)
- Minimum Return: 0% (soft threshold vs 3% minimum)
- Deduplication: By market/mode/strategy type to ensure diversity
- Ranking: By trade count (frequency → more data points → higher confidence)

---

## 2. Member Composition

**Core Members (weight 1.15 + 1.05)**:
- `HF10DAY_DD_M_MERLUSDT_15m` (814 trades, PF 1.012, DD 1.49%)
- `HF10DAY_ZZ_M_MERLUSDT_15m` (814 trades, PF 1.012, DD 1.49%)

**Satellite Members (weight 0.9 each)**:
- `HF10DAY_DD_S_AUCTIONUSDT_MERLUSDT_30m` (591 trades, PF 1.012, DD 1.24%)
- `HF10DAY_ZZ_S_AUCTIONUSDT_MERLUSDT_30m` (591 trades, PF 1.012, DD 1.24%)
- `HF10DAY_DD_S_MERLUSDT_SOMIUSDT_30m` (590 trades, PF 1.001, DD 1.33%)

---

## 3. Files Reference

### Data Files
- **Specification**: `results/btdd_d1_curated_high_trade_v1.json`
  - Contains full member detail, metrics, and metadata
  - Ready for import into catalog or off-chain reference

### Code Changes
- **Backend Service**: `backend/src/saas/service.ts`
  - New export: `registerCuratedHighTradeTS(apiKeyName, activate?: boolean)`
  - Reads v1 spec from JSON file
  - Creates trading system with members via `createTradingSystem()`
  - Auto-converts member format to `TradingSystemMemberDraft`

- **API Route**: `backend/src/api/saasRoutes.ts`
  - New endpoint: `POST /api/saas/admin/register-curated-high-trade-ts`
  - Body: `{ apiKeyName?: "BTDD_D1", activate?: false }`
  - Returns: Newly created `TradingSystem` object with full member list

---

## 4. Deployment Steps

### Step 1: Deploy Backend Build to VPS
```bash
# Local
npm run build           # Build backend TS → JS (already done)

# VPS (ssh root@176.57.184.98)
cd /opt/battletoads-double-dragon
git fetch --all --prune
git reset --hard origin/main
cd backend
npm run build           # Rebuild bot/trading logic
systemctl restart btdd-api
sleep 5; curl -s http://localhost:3001/api/status | jq .
```

### Step 2: Upload Curated TS Spec File
```bash
# VPS already has results/ directory, just ensure v1 spec is present
scp results/btdd_d1_curated_high_trade_v1.json \
  root@176.57.184.98:/opt/battletoads-double-dragon/results/
```

### Step 3: Trigger Registration via Admin Console
**Option A: Direct HTTP call** (Requires admin auth token)
```bash
curl -X POST http://176.57.184.98/api/saas/admin/register-curated-high-trade-ts \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <admin_token>" \
  -d '{
    "apiKeyName": "BTDD_D1",
    "activate": false
  }'
```

**Option B: Via SaaS Admin UI**
- Login → SaaS Admin Console
- Find "High-Trade Recommendations" card
- Click "Register as Trading System"
- Confirm activation status

### Step 4: Verify Registration
```bash
curl http://176.57.184.98/api/admin/trading-systems/BTDD_D1 | jq '.[].name'
# Output should include: "HIGH-TRADE CURATED TS v1 [2026-03-26]"
```

---

## 5. Client Assignment Workflow

### For Strategy Client (Traditional)
1. **In SaaS Admin**: Published Offers → Find "HIGH-TRADE CURATED TS v1"
2. **Create Offer**: Tag source = `curated_high_trade`, set description
3. **Client View**: Algorithm Storefront → Select TS → Get draft preview
4. **Confirm**: Provision trading system on client API key

### For Algofund Client (New Multi-TS)
1. **In SaaS Admin**: Algofund Management → Select profile
2. **Multi-TS Cell**: Scroll to "Active Systems" card
3. **Quick Add**: Search "HIGH-TRADE" → Add with weight (default 1.0)
4. **Enable/Disable**: Per-TS toggles (watch for pair-conflict warnings)
5. **Monitor**: Live P&L, trade frequency, margin load

---

## 6. Performance Monitoring Checklist

### Pre-Launch (VPS)
- [ ] Backend build successful, no type errors
- [ ] API endpoint callable: `/api/saas/admin/register-curated-high-trade-ts`
- [ ] JSON spec file exists and valid: `btdd_d1_curated_high_trade_v1.json`
- [ ] TS registered: `HIGH-TRADE CURATED TS v1 [2026-03-26]` visible in admin list

### Post-Launch (First 24h)
- [ ] Clients see TS in storefront or multi-TS list
- [ ] No 500 errors on assignment
- [ ] Live trades executing on all 5 member strategies
- [ ] P&L tracking in admin performance report
- [ ] Grand-sweep heavy batch running in background (check `/tmp/btdd_grand_sweep_heavy.log`)

### Stability Metrics (48h)
- [ ] Win rate within ±5% of backtest (52% → 47–57% acceptable range)
- [ ] Drawdown within ±2x backtest (1.36% → max 2.7%)
- [ ] Trade frequency ≥ 7/day (all 5 members combined)
- [ ] No repeated connections/disconnections on exchange

---

## 7. Grand Sweep Continuation (Background)

While v1 is deployed to clients, grand-sweep heavy is running in parallel:

**ETA**: 4–6 hours from launch  
**Contours Running**:
- A: Liquidity synth pairs (90d, ~540 runs, 1.5–2h)
- B: HF short timeframe (60d, ~360 runs, 2–3h)
- C: Regime robustness rescore (existing pool, ~5–15m)
- D: Multi-TF correlation check (top-100, ~5–10m)

**Next Action**: Monitor `/tmp/btdd_grand_sweep_heavy.log` every 30 minutes

Once initial artifacts appear (usually within 2–4 hours):
1. Run `registerCuratedHighTradeTS()` analysis on new sweep data
2. Generate **HIGH-TRADE CURATED TS v2** with updated members
3. Publish v2 to clients alongside v1 for A/B testing
4. Report back with v2 member list, PF, and DD metrics

---

## 8. Rollback Plan

If issues occur:

### Scenario: TS not registering
1. Check JSON spec file exists: `ls -la /opt/battletoads-double-dragon/results/btdd_d1_curated_high_trade_v1.json`
2. Check API logs: `tail -100 /var/log/btdd-api.log`
3. Verify API key exists: `curl http://localhost:3001/api/admin/api-keys | grep BTDD_D1`

### Scenario: Members not executing
1. Check member strategy IDs exist: `SELECT id FROM strategies WHERE id IN (53932, 54274, ...)`
2. Verify API key can create systems: `curl http://localhost:3001/api/admin/trading-systems/BTDD_D1`
3. Check exchange connectivity: review `/var/log/btdd-*.log` for auth/network errors

### Scenario: Disable TS (keep spec for v2 generation)
1. **In Admin Console**: TS list → Find v1 → Toggle OFF
2. **In DB**: `UPDATE trading_systems SET is_active=0 WHERE name LIKE 'HIGH-TRADE%'`
3. **Clients unaffected**: Existing assignments unchanged, no new assignments allowed

---

## 9. What's Next?

### Immediate (Now → +2h)
- ✅ Deploy backend + curated spec to VPS
- ✅ Register TS via API endpoint
- ✅ Assign to first pilot Algofund client
- ⏳ Monitor live execution

### Near-term (Now → +6h)
- Monitor grand-sweep progress
- Collect initial v2 candidates once artifacts appear
- Generate HIGH-TRADE CURATED TS v2 with updated metrics
- Release v2 summary to stakeholders

### Medium-term (Now → +1 week)
- Compare v1 vs v2 vs baseline performance
- Expand client assignments iteratively
- Implement tagged source labels (legacy | curated_high_trade | grand_sweep_*)
- Create weekly research report

---

## 10. Contact & Support

**For Issues During Deployment**:
- Check `backend/src/saas/service.ts` function `registerCuratedHighTradeTS` (line ~4550)
- Check `backend/src/api/saasRoutes.ts` endpoint registration (line ~140)
- Review API logs on VPS: `/var/log/btdd-api.log`

**For Member Questions**:
- Each member has backtest metrics in `results/btdd_d1_curated_high_trade_v1.json`
- Strategy details (rules, parameters) in VPS repo or via query API
- P&L tracking available in admin performance report

**For Grand Sweep Updates**:
- Check plan: `docs/GRAND_SWEEP_v2_RESEARCH_PLAN.md`
- Log tail: `ssh root@176.57.184.98 'tail /tmp/btdd_grand_sweep_heavy.log'`
