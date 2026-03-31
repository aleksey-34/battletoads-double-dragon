import argparse
import json
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path


RISK_MULTIPLIERS = {
    'low': 0.6,
    'medium': 1.0,
    'high': 1.4,
}


def load_json(path: Path):
    with path.open('r', encoding='utf-8') as handle:
        return json.load(handle)


def as_str(value, default=''):
    if value is None:
        return default
    text = str(value).strip()
    return text if text else default


def as_num(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def family_key(record):
    return '|'.join([
        as_str(record.get('strategyType')),
        as_str(record.get('marketMode')),
        as_str(record.get('market')),
        as_str(record.get('interval')),
    ])


def risk_multiplier(level):
    return RISK_MULTIPLIERS.get(level, 1.0)


def build_equity_points(total_return_percent):
    start = 10000.0
    end = round(start * (1 + as_num(total_return_percent, 0.0) / 100.0), 4)
    now_ms = int(datetime.now(tz=timezone.utc).timestamp() * 1000)
    return [
        {'time': now_ms - 1000, 'equity': start},
        {'time': now_ms, 'equity': end},
    ]


def pick_family_trade_rows(anchor, family_rows):
    pool = [row for row in family_rows if int(as_num(row.get('strategyId'), 0)) > 0]
    pool.sort(key=lambda row: (as_num(row.get('tradesCount'), 0), -as_num(row.get('score'), 0)))
    if not pool:
        return {
            'low': anchor,
            'medium': anchor,
            'high': anchor,
        }

    anchor_strategy_id = int(as_num(anchor.get('strategyId'), 0))
    medium = next((row for row in pool if int(as_num(row.get('strategyId'), 0)) == anchor_strategy_id), None)
    if medium is None:
        medium = anchor if anchor else pool[len(pool) // 2]

    return {
        'low': pool[0],
        'medium': medium,
        'high': pool[-1],
    }


def build_preset_from_record(record, risk_level):
    risk_mul = risk_multiplier(risk_level)
    score_base = as_num(record.get('score'), 0)
    total_return = as_num(record.get('totalReturnPercent'), 0) * risk_mul
    drawdown = as_num(record.get('maxDrawdownPercent'), 0) * risk_mul
    trades = max(1, round(as_num(record.get('tradesCount'), 0)))
    return {
        'strategyId': int(as_num(record.get('strategyId'), 0)),
        'strategyName': as_str(record.get('strategyName'), f"Strategy {record.get('strategyId') or 0}"),
        'score': round(score_base * (0.8 + 0.2 * risk_mul), 3),
        'metrics': {
            'ret': round(total_return, 3),
            'pf': round(as_num(record.get('profitFactor'), 1), 3),
            'dd': round(drawdown, 3),
            'wr': round(as_num(record.get('winRatePercent'), 0), 3),
            'trades': trades,
        },
        'params': {
            'interval': as_str(record.get('interval'), '4h'),
            'length': max(2, round(as_num(record.get('length'), 50))),
            'takeProfitPercent': as_num(record.get('takeProfitPercent'), 0),
            'detectionSource': as_str(record.get('detectionSource'), 'close'),
            'zscoreEntry': as_num(record.get('zscoreEntry'), 2),
            'zscoreExit': as_num(record.get('zscoreExit'), 0.5),
            'zscoreStop': as_num(record.get('zscoreStop'), 3),
        },
    }


def build_offer_from_record(record, family_rows):
    raw_mode = as_str(record.get('marketMode'), 'mono').lower()
    mode = 'synth' if raw_mode in {'synth', 'synthetic'} else 'mono'
    trade_rows = pick_family_trade_rows(record, family_rows)
    preset_matrix = {
        'low': {
            'low': build_preset_from_record(trade_rows['low'], 'low'),
            'medium': build_preset_from_record(trade_rows['medium'], 'low'),
            'high': build_preset_from_record(trade_rows['high'], 'low'),
        },
        'medium': {
            'low': build_preset_from_record(trade_rows['low'], 'medium'),
            'medium': build_preset_from_record(trade_rows['medium'], 'medium'),
            'high': build_preset_from_record(trade_rows['high'], 'medium'),
        },
        'high': {
            'low': build_preset_from_record(trade_rows['low'], 'high'),
            'medium': build_preset_from_record(trade_rows['medium'], 'high'),
            'high': build_preset_from_record(trade_rows['high'], 'high'),
        },
    }
    medium_medium = preset_matrix['medium']['medium']
    metrics = {
        'ret': as_num(record.get('totalReturnPercent'), 0),
        'pf': as_num(record.get('profitFactor'), 1),
        'dd': as_num(record.get('maxDrawdownPercent'), 0),
        'wr': as_num(record.get('winRatePercent'), 0),
        'trades': max(0, int(as_num(record.get('tradesCount'), 0))),
        'score': as_num(record.get('score'), 0),
        'robust': bool(record.get('robust')),
    }
    strategy_type = as_str(record.get('strategyType'), 'DD_BattleToads')
    strategy_id = int(as_num(record.get('strategyId'), 0))
    return {
        'offerId': f"offer_{mode}_{strategy_type.lower()}_{strategy_id}",
        'titleRu': f"{mode.upper()} • {strategy_type} • {as_str(record.get('market'))}",
        'descriptionRu': 'Автоматически собрано из записи исторического sweep.',
        'strategy': {
            'id': strategy_id,
            'name': as_str(record.get('strategyName'), f'Strategy {strategy_id}'),
            'type': strategy_type,
            'mode': mode,
            'market': as_str(record.get('market')),
            'params': medium_medium['params'],
        },
        'metrics': metrics,
        'sliderPresets': {
            'risk': {
                'low': preset_matrix['low']['medium'],
                'medium': medium_medium,
                'high': preset_matrix['high']['medium'],
            },
            'tradeFrequency': {
                'low': preset_matrix['medium']['low'],
                'medium': medium_medium,
                'high': preset_matrix['medium']['high'],
            },
        },
        'presetMatrix': preset_matrix,
        'equity': {
            'source': 'sweep_fallback',
            'generatedAt': datetime.now(tz=timezone.utc).isoformat().replace('+00:00', 'Z'),
            'points': build_equity_points(metrics['ret']),
            'summary': {
                'finalEquity': round(10000 * (1 + metrics['ret'] / 100.0), 4),
                'totalReturnPercent': metrics['ret'],
                'maxDrawdownPercent': metrics['dd'],
                'winRatePercent': metrics['wr'],
                'profitFactor': metrics['pf'],
                'tradesCount': metrics['trades'],
            },
        },
    }


def build_catalog(sweep, offer_shortlist, ts_draft):
    evaluated = list(sweep.get('evaluated') or [])
    by_strategy_id = {int(as_num(row.get('strategyId'), 0)): row for row in evaluated}
    family_rows_by_key = {}
    for row in evaluated:
        family_rows_by_key.setdefault(family_key(row), []).append(row)

    offers = []
    for candidate in offer_shortlist.get('offerCandidates') or []:
        strategy_id = int(as_num(candidate.get('strategyId'), 0))
        record = by_strategy_id.get(strategy_id)
        if record is None:
            raise SystemExit(f'Missing offer strategyId in sweep: {strategy_id}')
        offers.append(build_offer_from_record(record, family_rows_by_key.get(family_key(record), [record])))

    mono_offers = [offer for offer in offers if offer.get('strategy', {}).get('mode') == 'mono']
    synth_offers = [offer for offer in offers if offer.get('strategy', {}).get('mode') == 'synth']

    draft_members = []
    for member in ts_draft.get('members') or []:
        strategy_id = int(as_num(member.get('strategyId'), 0))
        record = by_strategy_id.get(strategy_id)
        if record is None:
            raise SystemExit(f'Missing TS draft strategyId in sweep: {strategy_id}')
        draft_members.append({
            'strategyId': strategy_id,
            'strategyName': as_str(record.get('strategyName'), f'Strategy {strategy_id}'),
            'strategyType': as_str(record.get('strategyType'), 'DD_BattleToads'),
            'marketMode': 'synth' if as_str(record.get('marketMode'), 'mono').lower() in {'synth', 'synthetic'} else 'mono',
            'market': as_str(record.get('market')),
            'score': as_num(record.get('score'), 0),
            'weight': round(as_num(member.get('memberWeight'), member.get('weight', 1.0)), 4),
        })

    timestamp = datetime.now(tz=timezone.utc).isoformat().replace('+00:00', 'Z')
    return {
        'timestamp': timestamp,
        'apiKeyName': as_str(sweep.get('apiKeyName')),
        'source': {
            'sweepFile': as_str(sweep.get('_sourceFile'), 'generated:expanded_catalog_v2'),
            'sweepTimestamp': as_str(sweep.get('timestamp')) or None,
            'policy': as_str(offer_shortlist.get('policy'), 'EXPANDED_V2_REPLACEMENT'),
            'sourceSweep': as_str(offer_shortlist.get('sourceSweep')),
            'generatedBy': 'scripts/build_expanded_catalog_v2.py',
        },
        'config': deepcopy(sweep.get('config') or {}),
        'counts': {
            'evaluated': max(0, len(evaluated)),
            'robust': sum(1 for row in evaluated if bool(row.get('robust'))),
            'monoCatalog': len(mono_offers),
            'synthCatalog': len(synth_offers),
            'adminTsMembers': len(draft_members),
            'durationSec': max(0, int(as_num((sweep.get('counts') or {}).get('durationSec'), 0))),
        },
        'clientCatalog': {
            'mono': sorted(mono_offers, key=lambda item: -as_num((item.get('metrics') or {}).get('score'), 0)),
            'synth': sorted(synth_offers, key=lambda item: -as_num((item.get('metrics') or {}).get('score'), 0)),
        },
        'adminTradingSystemDraft': {
            'name': 'BTDD D1 Expanded TS v2',
            'members': draft_members,
            'sourcePortfolioSummary': list(sweep.get('portfolioResults') or []),
        },
    }


def main():
    parser = argparse.ArgumentParser(description='Build expanded BTDD client catalog v2 from historical sweep and curated shortlist.')
    parser.add_argument('--sweep', required=True, help='Path to historical sweep JSON')
    parser.add_argument('--offers', required=True, help='Path to expanded offer shortlist JSON')
    parser.add_argument('--draft', required=True, help='Path to TS v2 draft JSON')
    parser.add_argument('--output', required=True, help='Path to output client catalog JSON')
    args = parser.parse_args()

    sweep_path = Path(args.sweep)
    offers_path = Path(args.offers)
    draft_path = Path(args.draft)
    output_path = Path(args.output)

    sweep = load_json(sweep_path)
    sweep['_sourceFile'] = str(sweep_path).replace('\\', '/')
    offer_shortlist = load_json(offers_path)
    ts_draft = load_json(draft_path)
    catalog = build_catalog(sweep, offer_shortlist, ts_draft)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open('w', encoding='utf-8') as handle:
        json.dump(catalog, handle, ensure_ascii=False, indent=2)
        handle.write('\n')

    summary = {
        'output': str(output_path),
        'monoCatalog': len((catalog.get('clientCatalog') or {}).get('mono') or []),
        'synthCatalog': len((catalog.get('clientCatalog') or {}).get('synth') or []),
        'adminTsMembers': len((catalog.get('adminTradingSystemDraft') or {}).get('members') or []),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()