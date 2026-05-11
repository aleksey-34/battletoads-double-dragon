#!/usr/bin/env python3
import csv
import json
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Tuple


@dataclass
class LeadResult:
    row: Dict[str, str]
    score: int
    segment: str
    tags: List[str]
    reasons: List[str]
    message_subject: str
    message_body: str


SEGMENT_TEMPLATES = {
    "crypto_vc": {
        "subject": "Potential fit: AI-native crypto trading infra",
        "body": (
            "Hi {first_name},\n\n"
            "I noticed your focus on {focus_hint}. I am reaching out with a potential fit for your investment thesis. "
            "We are building BTDD: an AI-native crypto trading system with live multi-exchange execution, risk controls, and transparent performance analytics.\n\n"
            "Why this may be relevant:\n"
            "- AI + crypto execution infrastructure\n"
            "- Production-ready architecture with measurable runtime behavior\n"
            "- Clear path from research to monetizable strategy products\n\n"
            "If useful, I can send a concise 1-page overview and short demo links.\n\n"
            "Best,\n{sender_name}"
        ),
    },
    "ai_vc": {
        "subject": "AI infrastructure + applied fintech opportunity",
        "body": (
            "Hi {first_name},\n\n"
            "Given your background in {focus_hint}, I thought BTDD could be relevant. "
            "We are building AI-first trading infrastructure that turns research workflows into live, controlled execution products.\n\n"
            "Current strengths:\n"
            "- End-to-end AI-enabled strategy lifecycle\n"
            "- Strong risk and monitoring layer\n"
            "- Real-world deployment and measurable operating metrics\n\n"
            "Happy to share a focused summary and discuss if this fits your current investment focus.\n\n"
            "Best,\n{sender_name}"
        ),
    },
    "fintech_operator": {
        "subject": "Operator-first fintech/AI trading platform",
        "body": (
            "Hi {first_name},\n\n"
            "I saw your operator/investor profile in {focus_hint}, so I wanted to share BTDD. "
            "We are building an AI-powered trading platform focused on production reliability, risk control, and scalable strategy execution.\n\n"
            "What stands out:\n"
            "- Practical deployment over pure backtest narratives\n"
            "- Built-in control loops for safer execution\n"
            "- Clear productization path for strategy clients\n\n"
            "If interesting, I can send a brief investor note and product walkthrough.\n\n"
            "Best,\n{sender_name}"
        ),
    },
    "general_vc": {
        "subject": "BTDD: AI-powered crypto execution platform",
        "body": (
            "Hi {first_name},\n\n"
            "I am reaching out with BTDD, an AI-powered crypto execution and strategy platform. "
            "We combine research automation, risk management, and live deployment across exchanges.\n\n"
            "If this is within your current scope, I can send a short overview and key metrics.\n\n"
            "Best,\n{sender_name}"
        ),
    },
}


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower())


def classify_and_score(row: Dict[str, str]) -> Tuple[int, str, List[str], List[str], str]:
    title = norm(row.get("jobTitle", ""))
    company = norm(row.get("companyName", ""))
    location = norm(row.get("location", ""))

    tags: List[str] = []
    reasons: List[str] = []
    score = 0

    # Role signals
    if any(k in title for k in ["investor", "partner", "principal", "vc", "venture", "angel"]):
        score += 20
        tags.append("investor_role")
        reasons.append("Investor role keywords in title")

    if any(k in title for k in ["founder", "operator", "board", "ceo"]):
        score += 8
        tags.append("operator_signal")
        reasons.append("Operator/founder signal in title")

    # AI signals
    if any(k in title or k in company for k in ["ai", "artificial intelligence", "machine learning", "data"]):
        score += 18
        tags.append("ai_signal")
        reasons.append("AI-related keyword in title/company")

    # Crypto/web3 signals
    if any(k in title or k in company for k in ["crypto", "web3", "blockchain", "digital asset"]):
        score += 24
        tags.append("crypto_signal")
        reasons.append("Crypto/Web3 keyword in title/company")

    # Investment organization signals
    if any(k in company for k in ["capital", "ventures", "partners", "vc", "fund"]):
        score += 14
        tags.append("investment_firm_signal")
        reasons.append("Investment firm keyword in company")

    # Geography heuristic for startup finance hubs
    if any(k in location for k in ["san francisco", "new york", "london", "dubai", "singapore", "berlin", "toronto", "bengaluru"]):
        score += 6
        tags.append("hub_location")
        reasons.append("Major startup/investment hub")

    # Segment selection
    if "crypto_signal" in tags and "investment_firm_signal" in tags:
        segment = "crypto_vc"
    elif "ai_signal" in tags and "investment_firm_signal" in tags:
        segment = "ai_vc"
    elif "operator_signal" in tags:
        segment = "fintech_operator"
    else:
        segment = "general_vc"

    # Focus hint used in message body
    focus_hint = "your investment domain"
    if "crypto_signal" in tags:
        focus_hint = "crypto / web3 investing"
    elif "ai_signal" in tags:
        focus_hint = "AI and applied technology investing"
    elif "investment_firm_signal" in tags:
        focus_hint = row.get("companyName", "your firm") or "your firm"

    return min(score, 100), segment, sorted(set(tags)), reasons, focus_hint


def build_message(first_name: str, segment: str, focus_hint: str, sender_name: str) -> Tuple[str, str]:
    template = SEGMENT_TEMPLATES.get(segment, SEGMENT_TEMPLATES["general_vc"])
    subject = template["subject"]
    body = template["body"].format(
        first_name=(first_name or "there"),
        focus_hint=(focus_hint or "your investment focus"),
        sender_name=sender_name,
    )
    return subject, body


def process_csv(input_path: Path, out_dir: Path, sender_name: str, top_n: int) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)

    with input_path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        rows = list(reader)

    results: List[LeadResult] = []
    for row in rows:
        score, segment, tags, reasons, focus_hint = classify_and_score(row)
        subject, body = build_message(row.get("First Name", ""), segment, focus_hint, sender_name)
        results.append(
            LeadResult(
                row=row,
                score=score,
                segment=segment,
                tags=tags,
                reasons=reasons,
                message_subject=subject,
                message_body=body,
            )
        )

    results.sort(key=lambda x: x.score, reverse=True)

    enriched_path = out_dir / "leads_enriched.csv"
    shortlist_path = out_dir / "leads_shortlist.csv"
    stats_path = out_dir / "leads_stats.json"

    base_fields = list(rows[0].keys()) if rows else []
    add_fields = [
        "score",
        "segment",
        "tags",
        "reasons",
        "message_subject",
        "message_body",
    ]

    with enriched_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=base_fields + add_fields)
        writer.writeheader()
        for r in results:
            out_row = dict(r.row)
            out_row.update(
                {
                    "score": r.score,
                    "segment": r.segment,
                    "tags": "|".join(r.tags),
                    "reasons": "|".join(r.reasons),
                    "message_subject": r.message_subject,
                    "message_body": r.message_body,
                }
            )
            writer.writerow(out_row)

    with shortlist_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=base_fields + add_fields)
        writer.writeheader()
        for r in results[:top_n]:
            out_row = dict(r.row)
            out_row.update(
                {
                    "score": r.score,
                    "segment": r.segment,
                    "tags": "|".join(r.tags),
                    "reasons": "|".join(r.reasons),
                    "message_subject": r.message_subject,
                    "message_body": r.message_body,
                }
            )
            writer.writerow(out_row)

    segment_counts = Counter(r.segment for r in results)
    score_bands = defaultdict(int)
    for r in results:
        if r.score >= 70:
            score_bands["70-100"] += 1
        elif r.score >= 50:
            score_bands["50-69"] += 1
        elif r.score >= 30:
            score_bands["30-49"] += 1
        else:
            score_bands["0-29"] += 1

    stats = {
        "input_file": str(input_path),
        "total_rows": len(results),
        "top_n": top_n,
        "segment_counts": dict(segment_counts),
        "score_bands": dict(score_bands),
        "outputs": {
            "enriched_csv": str(enriched_path),
            "shortlist_csv": str(shortlist_path),
            "stats_json": str(stats_path),
        },
    }

    stats_path.write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    input_csv = Path("/home/yakovbyakov/projects/BTDD INV/Копия AI seeking investors from Rizon - leads-5.csv")
    output_dir = Path("/home/yakovbyakov/projects/BTDD INV/out")
    process_csv(
        input_path=input_csv,
        out_dir=output_dir,
        sender_name="Yakov",
        top_n=600,
    )
    print(f"Done. Outputs in: {output_dir}")
