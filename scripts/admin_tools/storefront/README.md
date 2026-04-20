# Storefront Admin Tools

These scripts are operational helpers for bulk storefront maintenance.
They are intentionally isolated from regular product code.

## Scripts

- `resync_snapshots_from_backtest.py` — bulk refresh of offer review snapshots.
- `resync_snapshots_v2.py` — API-driven resync that mirrors UI save flow.
- `resync_ts_snapshots.py` — bulk refresh of TS backtest snapshots.
- `vps_rebuild_storefront_full.py` — full destructive storefront rebuild.

## Safety

`vps_rebuild_storefront_full.py` is destructive.
It will run only with explicit confirmation flags:

```bash
python3 vps_rebuild_storefront_full.py \
  --apply \
  --confirm REBUILD_STOREFRONT
```

Without both flags, the script exits without writing to DB.

## Notes

- Run these only on intended environments.
- Prefer DB backup before destructive operations.
- Keep auth tokens and host-specific values outside git when possible.