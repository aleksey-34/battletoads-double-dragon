#!/usr/bin/env python3
"""
Investor Leads Pipeline v2 — with website enrichment + small/mid investor focus
Generates TWO message templates: LinkedIn (short) + email (full)
"""
import csv
import json
import re
import time
import urllib.request
import urllib.error
import urllib.parse
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Dict, List, Optional, Tuple


# ─── Config ───────────────────────────────────────────────────────────────────
INPUT_CSV = "/home/yakovbyakov/projects/BTDD INV/Копия AI seeking investors from Rizon - leads-5.csv"
OUT_DIR   = Path("/home/yakovbyakov/projects/BTDD INV/out_v2")
SENDER    = "Yakov"
TOP_N     = 400
FETCH_TOP = 150          # only fetch websites for the top-N by text score (speed)
REQUEST_TIMEOUT = 6      # seconds per HTTP request
DELAY_BETWEEN_FETCHES = 0.4  # polite delay

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; InvestorResearchBot/1.0; +https://btdd.io)",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en",
}


# ─── Score keywords ───────────────────────────────────────────────────────────
TITLE_HIGH = [
    "angel", "seed", "pre-seed", "venture", "partner", "general partner",
    "managing director", "investment", "portfolio", "fund manager",
    "chief investment", "cio", "founder", "co-founder", "principal",
]
TITLE_MED = [
    "analyst", "associate", "director", "advisor", "board",
    "executive", "officer", "ceo", "cto", "cfo",
]
COMPANY_CRYPTO = [
    "capital", "ventures", "fund", "invest", "blockchain", "crypto",
    "defi", "web3", "fintech", "digital asset", "coinbase", "binance",
    "alameda", "paradigm", "multicoin", "pantera", "polychain",
    "dragonfly", "spartan", "delphi",
]
COMPANY_AI_FIN = [
    "ai", "artificial intelligence", "ml", "quant", "algo", "trading",
    "fintech", "neobank", "payments", "a16z", "sequoia", "softbank",
    "y combinator", "techstars",
]
COMPANY_SMALL_POSITIVE = [
    "angel", "seed", "early stage", "micro", "family office",
    "scout", "emerging", "boutique", "incubator", "accelerator",
]
COMPANY_MEGA_PENALTY = [
    "bain capital", "blackrock", "goldman sachs", "jp morgan", "morgan stanley",
    "fidelity", "vanguard", "kkr", "carlyle", "blackstone", "softbank vision",
    "tiger global", "andreessen horowitz",   # too large / late-stage
]
LOCATION_CRYPTO_HUB = [
    "singapore", "dubai", "hong kong", "cayman", "british virgin",
    "zug", "crypto valley", "bahrain",
]

# ─── Message templates ────────────────────────────────────────────────────────
LINKEDIN_TEMPLATES = {
    "crypto_vc": (
        "Hi {first_name}, building BTDD — AI-native crypto trading infra with "
        "live multi-exchange execution & risk controls. Saw your work in {focus_hint}. "
        "Worth a quick chat? —{sender}"
    ),
    "ai_vc": (
        "Hi {first_name}, building BTDD — AI-first trading infrastructure turning "
        "research into live execution products. Matches your {focus_hint} focus. "
        "Open to connect? —{sender}"
    ),
    "fintech_operator": (
        "Hi {first_name}, building BTDD — crypto algo-trading platform for operators "
        "& advisors. Saw your background in {focus_hint}. Curious if there's a fit? —{sender}"
    ),
    "angel_seed": (
        "Hi {first_name}, raising early-stage round for BTDD — AI crypto trading system, "
        "live infra, real P&L. Thought of you given {focus_hint}. Worth 15 min? —{sender}"
    ),
    "general_vc": (
        "Hi {first_name}, building BTDD — AI-native crypto execution platform. "
        "Looking for aligned early investors. Open to a quick call? —{sender}"
    ),
}

EMAIL_TEMPLATES = {
    "crypto_vc": (
        "Subject: BTDD — AI-native crypto trading infra seeking early investors\n\n"
        "Hi {first_name},\n\n"
        "{personalised_line}"
        "I'm reaching out because we're raising an early round for BTDD — an AI-native crypto trading infrastructure platform.\n\n"
        "What we've built:\n"
        "• Multi-exchange live execution engine with per-strategy risk controls\n"
        "• AI-assisted strategy lifecycle: backtest → paper → live with automatic monitoring\n"
        "• SaaS layer: white-label for advisors, hedge desks, and family offices\n"
        "• Real operating metrics: P&L, drawdown, utilization tracked in production\n\n"
        "We're a small, technical team building for the serious end of crypto trading. "
        "The platform is live and generating measurable results.\n\n"
        "If BTDD fits your investment thesis, I'd love to share a 1-page summary and a short demo.\n\n"
        "Best,\n{sender}\n\nBTDD · btdd.io"
    ),
    "ai_vc": (
        "Subject: AI infrastructure opportunity in quantitative crypto trading\n\n"
        "Hi {first_name},\n\n"
        "{personalised_line}"
        "I'm writing to share BTDD — an AI-first quantitative trading infrastructure platform. "
        "We connect research workflows directly to live execution with full risk controls and monitoring.\n\n"
        "Key technical highlights:\n"
        "• AI-driven strategy generation and lifecycle management\n"
        "• Live multi-exchange execution with dynamic position sizing\n"
        "• Automated performance analytics and drift detection\n"
        "• SaaS licensing to trading desks and advisors\n\n"
        "We're at early-stage, technically mature, and looking for aligned investors who understand "
        "applied AI in financial infrastructure.\n\n"
        "Happy to share details and a demo link.\n\n"
        "Best,\n{sender}\n\nBTDD · btdd.io"
    ),
    "fintech_operator": (
        "Subject: BTDD — crypto trading SaaS for operators & advisors\n\n"
        "Hi {first_name},\n\n"
        "{personalised_line}"
        "I'm reaching out about BTDD — a crypto algorithmic trading platform designed for "
        "operators, advisors, and trading desks. We handle execution, risk, and reporting "
        "so teams can focus on strategy.\n\n"
        "What makes it different:\n"
        "• Multi-exchange execution with per-strategy risk controls\n"
        "• White-label SaaS: your brand, your clients, managed risk\n"
        "• Live performance dashboard with P&L, drawdown, utilization\n\n"
        "We're raising an early round to scale the SaaS distribution. "
        "If this fits your fintech investment or operational focus, let's talk.\n\n"
        "Best,\n{sender}\n\nBTDD · btdd.io"
    ),
    "angel_seed": (
        "Subject: Early-stage investment opportunity — AI crypto trading platform\n\n"
        "Hi {first_name},\n\n"
        "{personalised_line}"
        "I'm reaching out because you invest at the early stage and BTDD might be a good fit.\n\n"
        "We're building an AI-native crypto trading infrastructure platform — live, generating "
        "real P&L, with a SaaS layer for advisors and trading desks. Small team, big technical "
        "foundation, raising our first outside round.\n\n"
        "Why now: institutional-grade crypto trading tools are in demand but underserved at "
        "the accessible-SaaS layer. We've built that layer.\n\n"
        "Happy to send a short overview and live demo link if this sounds interesting.\n\n"
        "Best,\n{sender}\n\nBTDD · btdd.io"
    ),
    "general_vc": (
        "Subject: BTDD — AI crypto trading infrastructure, early-stage round\n\n"
        "Hi {first_name},\n\n"
        "{personalised_line}"
        "I'm Yakov, co-founder of BTDD — an AI-native crypto algorithmic trading platform. "
        "We're raising an early round and reaching out to aligned investors.\n\n"
        "BTDD in brief:\n"
        "• Live AI-assisted trading execution across major exchanges\n"
        "• SaaS distribution to advisors and trading teams\n"
        "• Real-world operating metrics and transparent P&L reporting\n\n"
        "If crypto infrastructure + applied AI fits your current focus, I'd be happy to share "
        "a concise overview.\n\n"
        "Best,\n{sender}\n\nBTDD · btdd.io"
    ),
}


# ─── HTML text extractor ──────────────────────────────────────────────────────
class TextExtractor(HTMLParser):
    SKIP_TAGS = {"script", "style", "noscript", "svg", "nav", "footer", "header"}

    def __init__(self):
        super().__init__()
        self.result: List[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP_TAGS:
            self._skip += 1

    def handle_endtag(self, tag):
        if tag in self.SKIP_TAGS and self._skip > 0:
            self._skip -= 1

    def handle_data(self, data):
        if self._skip == 0:
            t = data.strip()
            if len(t) > 15:
                self.result.append(t)

    def get_text(self) -> str:
        return " ".join(self.result)


def html_to_text(html: bytes) -> str:
    try:
        text = html.decode("utf-8", errors="replace")
        parser = TextExtractor()
        parser.feed(text)
        return parser.get_text()
    except Exception:
        return ""


# ─── Website resolution ───────────────────────────────────────────────────────
def guess_domain(company_name: str) -> Optional[str]:
    """Guess a likely website URL from company name."""
    if not company_name or len(company_name.strip()) < 2:
        return None
    slug = re.sub(r"[^a-z0-9]", "", company_name.lower().replace(" ", ""))
    if not slug:
        return None
    return f"https://{slug}.com"


def fetch_website_text(url: str) -> str:
    """Fetch homepage text, return up to 1000 chars of relevant text."""
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            if resp.status != 200:
                return ""
            content_type = resp.headers.get("Content-Type", "")
            if "html" not in content_type:
                return ""
            raw = resp.read(60_000)  # max 60KB
            text = html_to_text(raw)
            return text[:1200]
    except Exception:
        return ""


WEBSITE_CRYPTO_SIGNALS = [
    "crypto", "blockchain", "defi", "web3", "bitcoin", "ethereum",
    "token", "trading", "fund", "portfolio", "invest", "venture",
    "algorithm", "quant", "ai", "fintech",
]


def score_website_text(text: str) -> Tuple[int, str]:
    """Return (bonus_score 0-20, excerpt)."""
    if not text:
        return 0, ""
    low = text.lower()
    hits = sum(1 for kw in WEBSITE_CRYPTO_SIGNALS if kw in low)
    bonus = min(hits * 2, 20)
    # extract a short meaningful excerpt
    sentences = re.split(r"[.!?]", text)
    relevant = [s.strip() for s in sentences if len(s.strip()) > 30][:3]
    excerpt = ". ".join(relevant)[:300]
    return bonus, excerpt


# ─── Scoring ──────────────────────────────────────────────────────────────────
def classify_and_score(row: Dict) -> Tuple[int, str, List[str], List[str]]:
    title   = (row.get("jobTitle", "") or "").lower()
    company = (row.get("companyName", "") or "").lower()
    loc     = (row.get("location", "") or "").lower()

    score = 0
    tags: List[str] = []
    reasons: List[str] = []
    segment = "general_vc"

    # Mega-fund penalty
    for pen in COMPANY_MEGA_PENALTY:
        if pen in company:
            score -= 30
            reasons.append(f"mega-fund penalty ({pen})")
            break

    # Title scoring
    for kw in TITLE_HIGH:
        if kw in title:
            score += 20
            tags.append(f"title:{kw}")
            reasons.append(f"senior title ({kw})")
            break
    else:
        for kw in TITLE_MED:
            if kw in title:
                score += 10
                tags.append(f"title:{kw}")
                break

    # Angel/seed boost — small investor focus
    angel_signals = ["angel", "seed", "pre-seed", "early stage", "micro fund",
                     "family office", "scout", "super angel"]
    for sig in angel_signals:
        if sig in title or sig in company:
            score += 25
            segment = "angel_seed"
            tags.append("angel_seed")
            reasons.append(f"angel/seed signal ({sig})")
            break

    # Crypto company
    for kw in COMPANY_CRYPTO:
        if kw in company:
            score += 15
            tags.append(f"co:{kw}")
            if segment == "general_vc":
                segment = "crypto_vc"
            break

    # AI/fintech company
    for kw in COMPANY_AI_FIN:
        if kw in company:
            score += 10
            tags.append(f"co:ai_fin:{kw}")
            if segment == "general_vc":
                segment = "ai_vc"
            break

    # Small/boutique boost
    for kw in COMPANY_SMALL_POSITIVE:
        if kw in company:
            score += 8
            tags.append("boutique")
            break

    # Location
    for hub in LOCATION_CRYPTO_HUB:
        if hub in loc:
            score += 8
            tags.append(f"hub:{hub}")
            break

    # Fintech operator
    if "operator" in title or "platform" in company or "exchange" in company:
        if segment == "general_vc":
            segment = "fintech_operator"

    # Has LinkedIn
    li = (row.get("linkedIn", "") or "").strip()
    if li and li.startswith("http"):
        score += 5
        tags.append("has_linkedin")

    return max(0, min(100, score)), segment, tags, reasons


def apply_website_bonus(base_score: int, segment: str, bonus: int) -> int:
    return min(100, base_score + bonus)


# ─── Message builders ─────────────────────────────────────────────────────────
def build_focus_hint(title: str, company: str) -> str:
    hints = []
    if any(k in title.lower() for k in ["crypto", "blockchain", "web3", "defi"]):
        hints.append("crypto/web3")
    elif any(k in company.lower() for k in ["crypto", "blockchain", "defi"]):
        hints.append("crypto ventures")
    if any(k in title.lower() + company.lower() for k in ["ai", "ml", "quant"]):
        hints.append("AI/quant")
    if any(k in title.lower() for k in ["angel", "seed"]):
        hints.append("early-stage investing")
    if any(k in title.lower() for k in ["fintech", "payments", "neobank"]):
        hints.append("fintech")
    return ", ".join(hints) if hints else "venture investing"


def build_personalised_line(excerpt: str, company: str) -> str:
    if excerpt and len(excerpt) > 30:
        trimmed = excerpt[:150].strip()
        return f"I came across {company or 'your firm'} and noted your focus — {trimmed}...\n\n"
    if company:
        return f"I came across {company} and thought there might be alignment with what we're building.\n\n"
    return ""


def build_messages(
    first_name: str, segment: str, focus_hint: str,
    personalised_line: str, sender: str
) -> Tuple[str, str, str, str]:
    name = first_name or "there"
    li_tmpl = LINKEDIN_TEMPLATES.get(segment, LINKEDIN_TEMPLATES["general_vc"])
    email_tmpl = EMAIL_TEMPLATES.get(segment, EMAIL_TEMPLATES["general_vc"])

    li_msg = li_tmpl.format(
        first_name=name, focus_hint=focus_hint, sender=sender
    )
    email_full = email_tmpl.format(
        first_name=name, personalised_line=personalised_line, sender=sender
    )
    # split email into subject + body
    lines = email_full.split("\n", 1)
    email_subject = lines[0].replace("Subject: ", "").strip()
    email_body = lines[1].strip() if len(lines) > 1 else email_full

    return li_msg, email_subject, email_body


# ─── Main pipeline ────────────────────────────────────────────────────────────
def run():
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # --- Load CSV
    with open(INPUT_CSV, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
    print(f"Loaded {len(rows)} rows")

    # --- Pass 1: text scoring
    results = []
    for row in rows:
        score, segment, tags, reasons = classify_and_score(row)
        results.append({
            "row": row,
            "score": score,
            "segment": segment,
            "tags": tags,
            "reasons": reasons,
            "website_url": "",
            "website_excerpt": "",
            "website_bonus": 0,
            "final_score": score,
        })

    # Sort by text score, select top FETCH_TOP for website enrichment
    results.sort(key=lambda x: -x["score"])

    print(f"Top {FETCH_TOP} leads will get website enrichment...")
    for i, r in enumerate(results[:FETCH_TOP]):
        company = r["row"].get("companyName", "")
        url = guess_domain(company)
        if not url:
            continue
        text = fetch_website_text(url)
        bonus, excerpt = score_website_text(text)
        r["website_url"] = url if text else ""
        r["website_excerpt"] = excerpt
        r["website_bonus"] = bonus
        r["final_score"] = apply_website_bonus(r["score"], r["segment"], bonus)
        if (i + 1) % 10 == 0:
            print(f"  enriched {i+1}/{FETCH_TOP}...")
        time.sleep(DELAY_BETWEEN_FETCHES)

    # Final sort by final_score
    results.sort(key=lambda x: -x["final_score"])

    # --- Build messages + write enriched CSV
    enriched_path = OUT_DIR / "leads_enriched_v2.csv"
    fieldnames = [
        "First Name", "Last Name", "jobTitle", "companyName", "linkedIn", "location",
        "score", "final_score", "segment", "tags", "reasons",
        "website_url", "website_excerpt",
        "linkedin_message",
        "email_subject", "email_body",
    ]

    with open(enriched_path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for r in results:
            row = r["row"]
            first_name = row.get("First Name", "")
            company = row.get("companyName", "")
            title = row.get("jobTitle", "")
            focus_hint = build_focus_hint(title, company)
            personalised_line = build_personalised_line(r["website_excerpt"], company)
            li_msg, email_subj, email_body = build_messages(
                first_name, r["segment"], focus_hint, personalised_line, SENDER
            )
            writer.writerow({
                "First Name": first_name,
                "Last Name": row.get("Last Name", ""),
                "jobTitle": title,
                "companyName": company,
                "linkedIn": row.get("linkedIn", ""),
                "location": row.get("location", ""),
                "score": r["score"],
                "final_score": r["final_score"],
                "segment": r["segment"],
                "tags": "|".join(r["tags"]),
                "reasons": "|".join(r["reasons"]),
                "website_url": r["website_url"],
                "website_excerpt": r["website_excerpt"],
                "linkedin_message": li_msg,
                "email_subject": email_subj,
                "email_body": email_body,
            })

    print(f"Enriched CSV → {enriched_path}")

    # --- Shortlist (top N, score >= 35)
    shortlist = [r for r in results if r["final_score"] >= 35][:TOP_N]
    shortlist_path = OUT_DIR / "leads_shortlist_v2.csv"
    with open(shortlist_path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for r in shortlist:
            row = r["row"]
            first_name = row.get("First Name", "")
            company = row.get("companyName", "")
            title = row.get("jobTitle", "")
            focus_hint = build_focus_hint(title, company)
            personalised_line = build_personalised_line(r["website_excerpt"], company)
            li_msg, email_subj, email_body = build_messages(
                first_name, r["segment"], focus_hint, personalised_line, SENDER
            )
            writer.writerow({
                "First Name": first_name,
                "Last Name": row.get("Last Name", ""),
                "jobTitle": title,
                "companyName": company,
                "linkedIn": row.get("linkedIn", ""),
                "location": row.get("location", ""),
                "score": r["score"],
                "final_score": r["final_score"],
                "segment": r["segment"],
                "tags": "|".join(r["tags"]),
                "reasons": "|".join(r["reasons"]),
                "website_url": r["website_url"],
                "website_excerpt": r["website_excerpt"],
                "linkedin_message": li_msg,
                "email_subject": email_subj,
                "email_body": email_body,
            })

    print(f"Shortlist ({len(shortlist)}) → {shortlist_path}")

    # --- Stats
    from collections import Counter
    seg_counts = Counter(r["segment"] for r in results)
    bands = {"80-100": 0, "60-79": 0, "40-59": 0, "35-39": 0, "<35": 0}
    for r in results:
        s = r["final_score"]
        if s >= 80: bands["80-100"] += 1
        elif s >= 60: bands["60-79"] += 1
        elif s >= 40: bands["40-59"] += 1
        elif s >= 35: bands["35-39"] += 1
        else: bands["<35"] += 1

    stats = {
        "total_leads": len(results),
        "shortlist_size": len(shortlist),
        "segment_counts": dict(seg_counts),
        "score_bands": bands,
        "enriched_csv": str(enriched_path),
        "shortlist_csv": str(shortlist_path),
    }
    stats_path = OUT_DIR / "leads_stats_v2.json"
    stats_path.write_text(json.dumps(stats, indent=2, ensure_ascii=False))
    print(f"Stats → {stats_path}")
    print(json.dumps(stats, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    run()
