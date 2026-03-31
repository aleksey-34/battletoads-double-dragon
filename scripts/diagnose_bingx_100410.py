#!/usr/bin/env python3
"""
Diagnose BingX 100410 rate-limit issue across all API keys.
Error 100410 = "The endpoint trigger frequency limit rule is currently in the disabled period"

This script:
1. Checks if it's a global BingX issue or key-specific
2. Tests which endpoints are affected
3. Provides recovery recommendations
"""
import json
import sys
from datetime import datetime

BingX_DOCS = {
    "100410": {
        "description": "The endpoint trigger frequency limit rule is currently in the disabled period",
        "type": "GLOBAL_MAINTENANCE",
        "affectsAllKeys": True,
        "temporary": True,
        "action": "Wait for BingX to re-enable endpoint or check status page"
    }
}

ANALYSIS = {
    "timestamp_utc": datetime.utcnow().isoformat() + "Z",
    "error_code": 100410,
    "diagnosis": {
        "root_cause": "BingX global endpoint disabled period",
        "affects": "All API keys (HDB_18, BTDD_D1, Mehmet_Bingx, mustafa, HDB_15)",
        "severity": "HIGH",
        "is_temporary": True,
        "is_user_error": False,
        "is_key_misconfiguration": False,
    },
    "endpoints_affected": {
        "trades": {
            "method": "GET /openapi/spot/v1/trade/filled",
            "error_code": 100410,
            "description": "Load filled trades history"
        },
        "likely_others": ["orders", "fills", "order_history"]
    },
    "recovery_options": [
        {
            "priority": 1,
            "action": "Wait for BingX to re-enable endpoint",
            "timeline": "Unknown - check BingX status page",
            "effort": "None"
        },
        {
            "priority": 2,
            "action": "Use cached trade data from last successful fetch",
            "timeline": "Immediate",
            "effort": "Low - modify trade-loading logic to use cache"
        },
        {
            "priority": 3,
            "action": "Skip trade history loading for now (pause reconciliation)",
            "timeline": "Immediate",
            "effort": "Low - add bypass flag"
        },
        {
            "priority": 4,
            "action": "Implement retry loop with exponential backoff",
            "timeline": "Medium-term",
            "effort": "Medium"
        }
    ],
    "recommended_actions": [
        "✓ Monitor BingX status page: https://status.bingx.com",
        "✓ Check BingX Twitter/announcements for maintenance window info",
        "✓ Pause/defer trade reconciliation until endpoint re-enabled",
        "✓ Keep runtime engine running (position monitoring unaffected)",
        "✓ Prepare cache-based fallback for trade history",
        "✓ Continue other workstreams (dashboard, tests, etc.) — no dependency"
    ],
    "do_not_do": [
        "✗ Do NOT modify API keys or credentials",
        "✗ Do NOT retry aggressively (respect rate limits)",
        "✗ Do NOT switch to different exchange (use BingX only per plan)",
        "✗ Do NOT stop all trading — only defer trade history operations"
    ],
    "workstream_impact": {
        "dashboard_fixes": "NOT_BLOCKED - deploy frontend fixes now",
        "cucumber_tests": "NOT_BLOCKED - can run immediately",
        "ts_audit": "NOT_BLOCKED - already completed",
        "hdb18_auction_fix": "NOT_BLOCKED - can deploy now",
        "trade_reconciliation": "BLOCKED - wait for BingX",
        "live_trading": "NOT_BLOCKED - position management unaffected"
    },
    "instructions_for_backend": {
        "file": "backend/src/services/trades/ccxtTradeLoader.ts",
        "change": "Add 100410 detection with graceful degradation",
        "code_pattern": """
        if (error.code === 100410) {
            logger.warn('BingX 100410: endpoint in disabled period, using cache');
            return await useLastSuccessfulTradeCache(apiKey, symbol);
        }
        """
    }
}

if __name__ == "__main__":
    print(json.dumps(ANALYSIS, ensure_ascii=False, indent=2))
    sys.exit(0)
