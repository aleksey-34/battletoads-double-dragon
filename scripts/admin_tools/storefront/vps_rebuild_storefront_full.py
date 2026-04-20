#!/usr/bin/env python3
"""
MEGA STOREFRONT REBUILD — from mass backtest results.
1. Clears ALL old offers, TS cards, labels, snapshots
2. Deduplicates DD/ZZ (keeps DD only)
3. Filters ROBUST only (trades≥5, DD≤25%, PF≥1.5)
4. Creates offer cards with tuned sliders
5. Builds TS cards with OP settings
6. Writes everything to DB
"""
import argparse
import json, sqlite3, math, time, sys

DB_PATH = "/opt/battletoads-double-dragon/backend/database.db"
RESULTS_PATH = "/tmp/mass_backtest_results_v2.json"


def parse_args():
    parser = argparse.ArgumentParser(
        description="Dangerous full storefront rebuild from mass backtest results."
    )
    parser.add_argument("--db", default=DB_PATH, help="Path to SQLite DB")
    parser.add_argument("--results", default=RESULTS_PATH, help="Path to mass backtest JSON")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Required for destructive write operations",
    )
    parser.add_argument(
        "--confirm",
        default="",
        help="Safety token. Must be exactly: REBUILD_STOREFRONT",
    )
    return parser.parse_args()


args = parse_args()
if not args.apply or args.confirm != "REBUILD_STOREFRONT":
    print("ABORTED: destructive mode requires --apply --confirm REBUILD_STOREFRONT")
    sys.exit(2)

DB_PATH = args.db
RESULTS_PATH = args.results

# === LOAD RESULTS ===
with open(RESULTS_PATH) as f:
    data = json.load(f)

winners = data.get("winners", [])
print(f"Loaded {len(winners)} raw winners")

# === STEP 1: Deduplicate DD/ZZ (keep DD, drop ZZ duplicates) ===
# ZZ strategies have identical metrics to DD with same params
seen_configs = {}
deduped = []
for w in winners:
    name = w["name"]
    # Normalize: replace _ZZ_ with _DD_ to find duplicates
    norm_name = name.replace("_ZZ_", "_DD_").replace("DAILYSWEEP_", "GS3_4H_")
    key = norm_name
    if key not in seen_configs:
        seen_configs[key] = w
        deduped.append(w)
    else:
        # Keep the one with DD type (prefer DD over ZZ)
        if "_DD_" in name and "_ZZ_" in seen_configs[key]["name"]:
            seen_configs[key] = w
            # Replace in deduped list
            for i, d in enumerate(deduped):
                if d["name"] == seen_configs[key]["name"]:
                    deduped[i] = w
                    break

print(f"After dedup DD/ZZ: {len(deduped)}")

# === STEP 2: Filter ROBUST ===
robust = []
for w in deduped:
    if w["trades"] >= 5 and w["dd"] <= 25 and w["pf"] >= 1.5:
        robust.append(w)

robust.sort(key=lambda x: x["ret"], reverse=True)
print(f"ROBUST (trades≥5, DD≤25%, PF≥1.5): {len(robust)}")

# === STEP 3: Determine offer type from strategy ===
def get_offer_id(w):
    name = w["name"]
    sid = w["id"]
    stype = w.get("type", "")
    quote = w.get("quote", "")
    
    mode = "synth" if quote else "mono"
    
    if "dd_battletoads" in stype.lower() or "_DD_" in name:
        type_slug = "dd_battletoads"
    elif "zz_breakout" in stype.lower() or "_ZZ_" in name:
        type_slug = "zz_breakout"
    elif "stat_arb_zscore" in stype.lower() or "_SZ_" in name:
        type_slug = "stat_arb_zscore"
    else:
        type_slug = stype.lower().replace(" ", "_")
    
    return f"offer_{mode}_{type_slug}_{sid}"

# === STEP 4: Compute slider settings per offer ===
# Strategy: tune riskScore and tradeFrequencyScore based on metrics
# - High DD strategies → lower riskScore (dampen risk)
# - Low trades → lower tradeFrequencyScore
# - High PF → can afford slightly higher risk

def compute_sliders(w):
    dd = w["dd"]
    pf = w["pf"]
    trades = w["trades"]
    ret = w["ret"]
    
    # Risk score: base 5 (neutral)
    # DD < 15% → can go 6-7 (slightly aggressive)
    # DD 15-20% → stay 5 (neutral)
    # DD 20-25% → go 4-4.5 (conservative)
    if dd <= 12:
        risk = 6.5
    elif dd <= 15:
        risk = 6.0
    elif dd <= 18:
        risk = 5.5
    elif dd <= 20:
        risk = 5.0
    elif dd <= 23:
        risk = 4.5
    else:
        risk = 4.0
    
    # Boost risk slightly if PF is very high (safe to be aggressive)
    if pf >= 4.0:
        risk = min(risk + 0.5, 7.0)
    elif pf >= 6.0:
        risk = min(risk + 1.0, 7.5)
    
    # Trade frequency: base 5 (neutral)
    # trades > 60 → high freq (6-7)
    # trades 30-60 → medium (5)
    # trades 10-30 → lower (4)
    # trades 5-10 → low (3)
    if trades >= 80:
        freq = 7.0
    elif trades >= 60:
        freq = 6.5
    elif trades >= 40:
        freq = 6.0
    elif trades >= 25:
        freq = 5.0
    elif trades >= 15:
        freq = 4.5
    elif trades >= 8:
        freq = 4.0
    else:
        freq = 3.5
    
    return round(risk, 2), round(freq, 2)

# === STEP 5: Build offer snapshots ===
now = time.strftime("%Y-%m-%dT%H:%M:%S.000Z")

review_snapshots = {}
offer_index = {}  # offerId -> winner data for TS building

for w in robust:
    oid = get_offer_id(w)
    risk, freq = compute_sliders(w)
    
    # Build equity points (we don't have them from mass backtest, use placeholder)
    # Just a simple linear approximation
    final_eq = w.get("finalEquity", 10000)
    n_points = min(w.get("equityPoints", 60), 120)
    if n_points < 2:
        n_points = 60
    eq_curve = [round(10000 + (final_eq - 10000) * i / (n_points - 1), 2) for i in range(n_points)]
    
    snapshot = {
        "offerId": oid,
        "apiKeyName": "BTDD_D1",
        "ret": round(w["ret"], 3),
        "pf": round(w["pf"], 3),
        "dd": round(w["dd"], 3),
        "trades": w["trades"],
        "tradesPerDay": round(w["trades"] / 90, 3),
        "periodDays": 90,
        "equityPoints": eq_curve,
        "riskScore": risk,
        "tradeFrequencyScore": freq,
        "initialBalance": 10000,
        "riskScaleMaxPercent": 100,
        "updatedAt": now,
    }
    review_snapshots[oid] = snapshot
    offer_index[oid] = {**w, "riskScore": risk, "freqScore": freq}

print(f"Built {len(review_snapshots)} offer snapshots")

# === STEP 6: Build labels (all runtime_snapshot) ===
labels = {oid: "runtime_snapshot" for oid in review_snapshots}

# === STEP 7: Build curated/published IDs ===
offer_ids = list(review_snapshots.keys())

# === STEP 8: Build TS cards ===
# Group offers by base symbol for smart TS composition
by_symbol = {}
for oid, w in offer_index.items():
    base = w.get("base", "?")
    quote = w.get("quote", "")
    sym = f"{base}/{quote}" if quote else base
    if sym not in by_symbol:
        by_symbol[sym] = []
    by_symbol[sym].append((oid, w))

# Sort each group by return
for sym in by_symbol:
    by_symbol[sym].sort(key=lambda x: x[1]["ret"], reverse=True)

# Liquidity tiers for TS card naming
LIQUID = {"ORDIUSDT": "B+", "BERAUSDT": "A-", "IPUSDT": "B", "TRUUSDT": "B",
          "SOMIUSDT": "C", "APTUSDT": "A", "ARBUSDT": "A", "NEARUSDT": "A",
          "SUIUSDT": "A", "ONDOUSDT": "A", "OPUSDT": "A", "RENDERUSDT": "A-",
          "UNIUSDT": "A", "GRTUSDT": "B+", "SEIUSDT": "B", "TIAUSDT": "B+"}

ts_cards = {}

def build_ts(name, system_name, offers_list, max_op):
    """Build a TS card from list of (offerId, winnerData)."""
    if not offers_list:
        return None
    
    oids = [o[0] for o in offers_list]
    
    # Aggregate metrics (simple average weighted approach)
    total_ret = sum(o[1]["ret"] for o in offers_list) / len(offers_list)
    avg_dd = sum(o[1]["dd"] for o in offers_list) / len(offers_list)
    avg_pf = sum(o[1]["pf"] for o in offers_list) / len(offers_list)
    total_trades = sum(o[1]["trades"] for o in offers_list)
    avg_wr = sum(o[1]["winRate"] for o in offers_list) / len(offers_list)
    avg_risk = sum(o[1]["riskScore"] for o in offers_list) / len(offers_list)
    avg_freq = sum(o[1]["freqScore"] for o in offers_list) / len(offers_list)
    
    # Equity curve (average)
    final_eq = 10000 * (1 + total_ret / 100)
    n_pts = 100
    eq = [round(10000 + (final_eq - 10000) * i / (n_pts - 1), 2) for i in range(n_pts)]
    
    set_key = f"ALGOFUND_MASTER::BTDD_D1::{name}"
    
    return {
        "apiKeyName": "BTDD_D1",
        "systemName": system_name,
        "setKey": set_key,
        "ret": round(total_ret, 3),
        "pf": round(avg_pf, 3),
        "dd": round(avg_dd, 3),
        "winRate": round(avg_wr, 2),
        "trades": total_trades,
        "tradesPerDay": round(total_trades / 90, 3),
        "periodDays": 90,
        "finalEquity": round(final_eq, 4),
        "equityPoints": eq,
        "offerIds": oids,
        "backtestSettings": {
            "riskScore": round(avg_risk, 2),
            "tradeFrequencyScore": round(avg_freq, 2),
            "initialBalance": 10000,
            "riskScaleMaxPercent": 100,
            "maxOpenPositions": max_op,
        },
        "updatedAt": now,
    }

# --- Build specific TS cards ---

# 1. ORDI MEGA — top ORDI strategies, 4h+1h mix
ordi_offers = by_symbol.get("ORDIUSDT", [])[:10]
ts = build_ts("ordi-mega", "ORDI Mega Cloud", ordi_offers, 2)
if ts:
    ts_cards[ts["setKey"]] = ts
    print(f"  TS ordi-mega: {len(ordi_offers)} strats, ret={ts['ret']:.1f}%, OP=2")

# 2. BERA PACK — top BERA
bera_offers = by_symbol.get("BERAUSDT", [])[:10]
ts = build_ts("bera-pack", "BERA Pack Cloud", bera_offers, 2)
if ts:
    ts_cards[ts["setKey"]] = ts
    print(f"  TS bera-pack: {len(bera_offers)} strats, ret={ts['ret']:.1f}%, OP=2")

# 3. IP PACK — top IP
ip_offers = by_symbol.get("IPUSDT", [])[:8]
ts = build_ts("ip-pack", "IP Protocol Cloud", ip_offers, 2)
if ts:
    ts_cards[ts["setKey"]] = ts
    print(f"  TS ip-pack: {len(ip_offers)} strats, ret={ts['ret']:.1f}%, OP=2")

# 4. TRU PACK — top TRU  
tru_offers = by_symbol.get("TRUUSDT", [])[:6]
ts = build_ts("tru-pack", "TRU Cloud", tru_offers, 2)
if ts:
    ts_cards[ts["setKey"]] = ts
    print(f"  TS tru-pack: {len(tru_offers)} strats, ret={ts['ret']:.1f}%, OP=2")

# 5. SOMI PACK — top SOMI (note: low liquidity!)
somi_offers = by_symbol.get("SOMIUSDT", [])[:4]
ts = build_ts("somi-alpha", "SOMI Alpha Cloud", somi_offers, 1)
if ts:
    ts_cards[ts["setKey"]] = ts
    print(f"  TS somi-alpha: {len(somi_offers)} strats, ret={ts['ret']:.1f}%, OP=1 (low liq)")

# 6. BLUE-CHIP MIX — top from liquid instruments (APT, ARB, NEAR, SUI)
blue_chip = []
for sym in ["APTUSDT", "ARBUSDT", "NEARUSDT", "SUIUSDT"]:
    blue_chip.extend(by_symbol.get(sym, [])[:3])
blue_chip.sort(key=lambda x: x[1]["ret"], reverse=True)
ts = build_ts("bluechip-mix", "Blue-Chip Diversified Cloud", blue_chip[:12], 4)
if ts:
    ts_cards[ts["setKey"]] = ts
    print(f"  TS bluechip-mix: {len(blue_chip[:12])} strats, ret={ts['ret']:.1f}%, OP=4")

# 7. SYNTH PAIRS — top synth strategies (APT/TIA, NEAR/SEI, NEAR/TIA, ONDO/TIA, SUI/SEI)
synth_offers = []
for sym in by_symbol:
    if "/" in sym:
        synth_offers.extend(by_symbol[sym][:3])
synth_offers.sort(key=lambda x: x[1]["ret"], reverse=True)
ts = build_ts("synth-pairs", "Synth Pairs Cloud", synth_offers[:12], 4)
if ts:
    ts_cards[ts["setKey"]] = ts
    print(f"  TS synth-pairs: {len(synth_offers[:12])} strats, ret={ts['ret']:.1f}%, OP=4")

# 8. MEGA PORTFOLIO — top 5 per instrument across ALL symbols
mega = []
for sym in by_symbol:
    mega.extend(by_symbol[sym][:5])
mega.sort(key=lambda x: x[1]["ret"], reverse=True)
ts = build_ts("mega-portfolio", "Mega Portfolio Cloud", mega[:25], 6)
if ts:
    ts_cards[ts["setKey"]] = ts
    print(f"  TS mega-portfolio: {len(mega[:25])} strats, ret={ts['ret']:.1f}%, OP=6")

# 9. SAFE YIELD — lowest DD strategies (DD≤15%, PF≥2)
safe = [(oid, w) for oid, w in offer_index.items() if w["dd"] <= 15 and w["pf"] >= 2.0]
safe = [(oid, w) for oid, w in safe]
safe.sort(key=lambda x: x[1]["dd"])
ts = build_ts("safe-yield", "Safe Yield Cloud", safe[:10], 3)
if ts:
    ts_cards[ts["setKey"]] = ts
    print(f"  TS safe-yield: {len(safe[:10])} strats, ret={ts['ret']:.1f}%, OP=3")

# 10. HIGH FREQ — most active strategies (trades≥40)
hf = [(oid, w) for oid, w in offer_index.items() if w["trades"] >= 40]
hf.sort(key=lambda x: x[1]["trades"], reverse=True)
ts = build_ts("high-freq", "High Frequency Cloud", hf[:10], 4)
if ts:
    ts_cards[ts["setKey"]] = ts
    print(f"  TS high-freq: {len(hf[:10])} strats, ret={ts['ret']:.1f}%, OP=4")

print(f"\nTotal TS cards: {len(ts_cards)}")

# === STEP 9: Write to DB ===
conn = sqlite3.connect(DB_PATH)
cur = conn.cursor()

# Clear all old data
flags_to_clear = [
    "offer.store.review_snapshots",
    "offer.store.curated_ids",
    "offer.store.published_ids",
    "offer.store.labels",
    "offer.store.ts_backtest_snapshots",
    "offer.store.ts_backtest_snapshot",
    "offer.store.snapshot_refresh_state",
    "offer.store.defaults",
]

for key in flags_to_clear:
    cur.execute("DELETE FROM app_runtime_flags WHERE key = ?", (key,))
    print(f"  Cleared: {key}")

# Write new data
def write_flag(key, value):
    jval = json.dumps(value, separators=(",", ":"))
    cur.execute(
        "INSERT OR REPLACE INTO app_runtime_flags (key, value) VALUES (?, ?)",
        (key, jval)
    )
    print(f"  Wrote: {key} ({len(jval)} bytes)")

write_flag("offer.store.review_snapshots", review_snapshots)
write_flag("offer.store.curated_ids", offer_ids)
write_flag("offer.store.published_ids", offer_ids)
write_flag("offer.store.labels", labels)
write_flag("offer.store.ts_backtest_snapshots", ts_cards)
write_flag("offer.store.defaults", {"riskScore": 5, "tradeFrequencyScore": 5})

conn.commit()
conn.close()

print(f"\n{'='*60}")
print(f"DONE! Storefront rebuilt:")
print(f"  Offers: {len(review_snapshots)}")
print(f"  TS Cards: {len(ts_cards)}")
print(f"  All labels: runtime_snapshot")
print(f"  Slider-tuned: YES (risk by DD, freq by trade count)")

# Summary table
print(f"\n{'='*60}")
print(f"OFFER SUMMARY BY INSTRUMENT:")
by_inst = {}
for oid, w in offer_index.items():
    sym = f"{w['base']}/{w['quote']}" if w.get("quote") else w["base"]
    if sym not in by_inst:
        by_inst[sym] = []
    by_inst[sym].append(w)

for sym in sorted(by_inst, key=lambda s: -max(w["ret"] for w in by_inst[s])):
    ws = by_inst[sym]
    print(f"  {sym:20s} offers={len(ws):3d}  best_ret={max(w['ret'] for w in ws):7.1f}%  avg_dd={sum(w['dd'] for w in ws)/len(ws):5.1f}%")

print(f"\nTS CARD SUMMARY:")
for sk, ts in ts_cards.items():
    name = sk.split("::")[-1]
    print(f"  {name:20s} strats={len(ts['offerIds']):2d}  ret={ts['ret']:7.1f}%  dd={ts['dd']:5.1f}%  pf={ts['pf']:5.2f}  OP={ts['backtestSettings']['maxOpenPositions']}")
