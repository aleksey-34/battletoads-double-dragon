#!/usr/bin/env python3
"""Sequentially trigger /api/backtest/run for each strategy_id.

Per-strategy options resolved from the sweep checkpoint:
  - dateFrom = max(global_dateFrom, actualDataStartMs - warmup buffer)
  - bars     = generous; engine clips to available history
"""
import json, sys, time, urllib.request, urllib.error, argparse
from datetime import datetime

def post(url, body, token, timeout=180):
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                  headers={"Content-Type": "application/json",
                                           "Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ids-file", required=True)
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--api", default="http://127.0.0.1:3001/api/backtest/run")
    ap.add_argument("--token", default="btdd_admin_sweep_2026")
    ap.add_argument("--api-key-name", default="BTDD_D1")
    ap.add_argument("--data-api-key-name", default="", help="override data fetch route (e.g. BTDD_MEX_RESEARCH for missing pairs)")
    ap.add_argument("--global-date-from", default="2024-06-01T00:00:00Z")
    ap.add_argument("--bars", type=int, default=6000)
    ap.add_argument("--warmup", type=int, default=400)
    ap.add_argument("--initial", type=float, default=10000)
    ap.add_argument("--commission", type=float, default=0.1)
    ap.add_argument("--slippage", type=float, default=0.05)
    ap.add_argument("--out", default="/tmp/bulk_bt_results.jsonl")
    ap.add_argument("--sleep", type=float, default=0.3)
    args = ap.parse_args()

    ids = [int(x) for x in open(args.ids_file).read().strip().replace("\n",",").split(",") if x.strip()]
    print(f"target: {len(ids)} strategies", flush=True)

    cp = json.load(open(args.checkpoint))
    by_sid = {}
    for r in (cp.get("evaluated") or []):
        sid = r.get("strategyId")
        if sid:
            by_sid[int(sid)] = {
                "name": r.get("strategyName"),
                "interval": r.get("interval"),
                "actual_start_ms": r.get("actualDataStartMs"),
            }

    out = open(args.out, "w")
    ok = 0; fail = 0; t_start = time.time()
    for i, sid in enumerate(ids, 1):
        meta = by_sid.get(sid, {})
        actual = meta.get("actual_start_ms")
        if actual:
            pad_ms = 30 * 86400 * 1000  # 30d pre-padding for warmup
            iso = datetime.utcfromtimestamp(max(0, actual - pad_ms)/1000).strftime("%Y-%m-%dT%H:%M:%SZ")
            date_from = max(args.global_date_from, iso)
        else:
            date_from = args.global_date_from

        body = {"apiKeyName": args.api_key_name, "mode": "single", "strategyId": sid,
                "bars": args.bars, "warmupBars": args.warmup, "dateFrom": date_from,
                "initialBalance": args.initial, "commissionPercent": args.commission,
                "slippagePercent": args.slippage, "saveResult": True}
        if args.data_api_key_name:
            body["dataApiKeyName"] = args.data_api_key_name

        last_err = None; permanent = False; got = False
        for attempt in range(1, 6):
            try:
                t0 = time.time()
                r = post(args.api, body, args.token, timeout=180)
                dt = time.time() - t0
                summ = r.get("result", {}).get("summary", {})
                rec = {"sid": sid, "runId": r.get("runId"),
                       "totalReturnPct": summ.get("totalReturnPercent"),
                       "maxDD": summ.get("maxDrawdownPercent"),
                       "pf": summ.get("profitFactor"),
                       "trades": summ.get("tradesCount"),
                       "secs": round(dt,1), "dateFrom": date_from}
                out.write(json.dumps(rec) + "\n"); out.flush()
                ok += 1; got = True
                eta = (time.time()-t_start)/i * (len(ids)-i)
                print(f"[{i:3d}/{len(ids)}] sid={sid:6d} runId={r.get('runId')} "
                      f"ret={summ.get('totalReturnPercent',0):+7.2f}% dd={summ.get('maxDrawdownPercent',0):5.2f}% "
                      f"trades={summ.get('tradesCount',0):4d} ({dt:.1f}s ETA {eta/60:.1f}m df={date_from[:10]})", flush=True)
                break
            except urllib.error.HTTPError as e:
                body_text = e.read().decode("utf-8", "replace")[:200]
                last_err = f"HTTP {e.code}: {body_text}"
                if any(x in body_text for x in ("Not enough candles","Нет данных","No executable","No runnable","not found")):
                    permanent = True; break
                if e.code in (429, 503, 500):
                    backoff = min(2 ** attempt, 15)
                    print(f"  retry {attempt}: {last_err[:80]}  sleep {backoff}s", flush=True)
                    time.sleep(backoff); continue
                break
            except Exception as e:
                last_err = str(e)[:200]
                backoff = min(2 ** attempt, 10)
                print(f"  retry {attempt}: {last_err}  sleep {backoff}s", flush=True)
                time.sleep(backoff)
        if not got:
            fail += 1
            print(f"[{i:3d}/{len(ids)}] sid={sid} FAIL: {last_err[:120] if last_err else '?'}", flush=True)
            out.write(json.dumps({"sid": sid, "error": last_err}) + "\n"); out.flush()
        time.sleep(args.sleep)

    out.close()
    print(f"\ndone. ok={ok} fail={fail}  out={args.out}  total {time.time()-t_start:.0f}s")

if __name__ == "__main__":
    main()
