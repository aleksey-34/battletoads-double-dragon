# Stocks sleeve (WEEX short-MA) — critical review

**Date:** 2026-08-09
**Scope:** `addon-mrs-weex-stocks-shortma-jul2026` research → vitrine stamp gap.
**Verdict:** the sleeve is **published to live clients but not stamped on the storefront**, the
headline `+47.15%` is **void**, and path-accurate fills (2026-08-09) put the book at
**C −65% / lenient −21% / taker −16%** with only **13%** confirmed entry-first same-bar trips
(`results/stocks_hf_research_aug2026/path_accurate_rebaseline.md`). The
"dump stress vs SPX −37.76%" benchmark is **a memecoin, not the S&P 500**.
**Do not stamp.** Live MRS2 params were repaired; that does not make the BT edge real.

**Additional blocker (staggered portfolio rerun, 2026-08-09):** B3 still matches the July
vitrine to the decimal (`630.81% / 22.95%`), but the **MRS book returns 2.4×–7.3× more** on
the same candles/recipe (`staggered_portfolio_bt.md` / `stamp_candidate_aug2026.json`).

**Root cause (proven 2026-08-09):** July “MRS” stamp was **not MeanReversion**. Scripts wrote
`strategy_type='MeanReversion'`, but the engine build that stamped only recognized `MRS2`, so
unknown types fell through to **`DD_BattleToads`**. Forced-DD on the same legs reproduces July
MRS book returns to the decimal (1899.17 / 2068.9 / 6645.95). Current engine runs real MRS2 →
higher numbers. **Do not treat July MRS as a MeanReversion reproducibility target.**
Stocks on the join window alone are already **−2.08% maker / −5.27% taker**. `booksMeta`
already includes stocks + `joinDate=2026-06-17`; snapshot capital left at core 20k/30k.

No production state was changed by this review. All VPS queries were `sqlite3 -readonly`.

---

## 1. What is actually solid

These parts hold up and should be kept:

1. **The before/after comparison is internally window-aligned.** `research_stock_sleeve_shortma_jul2026.cjs`
   runs B3, MRS, ZZ and stocks all on `2026-03-19 → 2026-07-30`. Whatever else is wrong, it is not
   comparing a 4-month stocks book to a 1-year crypto book inside that one table.
2. **The equity-sum arithmetic is correct and reproducible.** Conservative: before `20000 × 1.4226 = 28452`,
   stocks `7357.75`, sum `35809.75` on `25000` capital = `+43.24%`. That matches the published table exactly.
3. **`capital_weight = 0.5` is internally consistent with the recipe.** Weight is expressed in units of
   $10k (b3 `1.0`=$10k, mrs aggressive `2.0`=$20k, quality-tilt `0.8`/`1.2`=$8k/$12k). `stocks 0.5` = $5k.
   The publish script wrote the right number for the intended semantics.
4. **The DB write itself succeeded and is clean.** System `id=257` exists, is active, `max_open_positions=6`,
   8 members, master card `id=112`. All six portfolios have a `stocks` member row at weight `0.5`.
5. **The legs are genuinely equity perps, not mislabeled tokens** — MU $888, IBM $221, AMZN $254, TSLA $308,
   BABA $116 are all plausible. (The one exception is the benchmark; see §6.)
6. **Realized commission matches the model.** Observed live fees run ~0.02–0.08% per side against a modeled
   0.036%. Fees are not the problem. Slippage is.

Everything below this line is a problem.

---

## 2. Question 1 — Was stocks researched but NOT stamped? Yes. Proof.

The sleeve was published on **2026-07-31**. The vitrine stamp was last written on **2026-07-17**
(triple-zz on 2026-07-22). The stamp was never re-run. Three independent pieces of evidence:

**(a) `docs/portfolio_five_1y_rerun_jul2026.json` has two books, not three.** Every portfolio's `books[]`
array contains only `b3` and `mrs` (plus `zz` for triple). No `stocks` role anywhere in the file.

**(b) The live DB snapshot still carries pre-stocks capital.** From `algofund_portfolios`:

| set_key | snapshot capital | metadata books | enabled members | implied capital from weights |
|---|---:|---:|---:|---:|
| conservative | 20 000 | 2 | 3 | 25 000 |
| balanced | 20 000 | 2 | 3 | 25 000 |
| aggressive | 30 000 | 2 | 3 | 35 000 |
| quality-tilt | 20 000 | 2 | 3 | 25 000 |
| triple-zz | 25 000 | 3 | 4 | 30 000 |
| whale (personal) | 30 000 | 2 | 3 | 35 000 |

Every row is internally contradictory: **members = 3, books = 2, capital = the 2-book number.**

**(c) There is a live code path that will silently produce garbage from this state.**
In `backend/src/saas/service.ts` the portfolio rerun resolves each member's parameters like this:

```7723:7737:backend/src/saas/service.ts
    const meta = booksMeta.find((b) => asString(b?.key, '') === role) || booksMeta[i] || {};
    const fromPayload = payloadMembers.find((m) => asString(m.role, '') === role);
    const op = Math.max(
      0,
      Math.floor(asNumber(fromPayload?.op, asNumber(meta?.op, 0))),
    );
    const lot = Math.max(0, asNumber(fromPayload?.lot, asNumber(meta?.lot, 0)));
    const weight = Math.max(0.01, asNumber(src.weight, 1));
    const capitalFromMeta = asNumber(meta?.initial, 0);
    const capital = Math.max(
      100,
      capitalFromMeta > 0
        ? capitalFromMeta
        : Math.round(snapshotCapital * (weight / weightSum)),
    );
```

For `role = 'stocks'`, `booksMeta.find(...)` misses (no stocks entry) and `booksMeta[2]` is `undefined`,
so `meta = {}`. Result: **`op = 0`, `lot = 0`, `ri = 0`**, and `capital = round(20000 × 0.5/2.5) = $4 000`
— not the researched OP6 / lot15 / ri100 / $5 000. Meanwhile `b3` and `mrs` still take their `meta.initial`
of $10k each, so the rerun's book capitals sum to **$24 000 against a declared `snapshotCapital` of $20 000**.

**Anyone who presses "rerun portfolio" today gets a silently wrong number.** This is the single most
urgent item in this memo, and it is a code/data defect, not a research opinion.

**(d) Bonus mismatch, unrelated to stocks.** `recipes.json` declares `sharedB3.ri = 50`, but the b3 entry in
`metadata.books` carries no `ri` key at all, so the rerun defaults it to `0` — and indeed the 1y rerun records
`"reinvest": 0` for every b3 book. The B3 reinvest setting disagrees between the recipe and the stamp.

---

## 3. Question 2 — Is Mar–Jul comparable to the 1y stamp? No, and it cuts both ways.

The vitrine window is `2025-08-07 → 2026-07-22` (350 days). The stocks window is `2026-03-19 → 2026-07-30`
(133 days) and is a **subset** of it. Splicing them is not conservative in either direction:

- **B3 is wildly front-loaded in the recent window.** B3 returns `+105.33%` over the full year but `+78.5%`
  in the last 4.4 months alone. Roughly three quarters of a year of B3 profit landed in the sample the
  stocks sleeve happens to cover.
- **MRS collapsed in exactly that window.** MRS on the 1y stamp is `+103%` (conservative) to `+285%`
  (aggressive). In Mar–Jul it earned `+6.03%`, `+3.70%` and `+4.63%` respectively. The MRS book has been
  essentially flat for four months.

So the short window is not "a smaller version of the year" — it is a *different regime* in which the two
existing books swapped roles. Pasting a 133-day stocks curve onto a 350-day crypto curve, or annualizing
either, produces a number that describes no period that ever existed.

There is a second, harder blocker: **you cannot build a 1y stocks book at all.** From the candle manifest,
no sleeve leg has any history before `2026-01-22`, and five of eight start after `2026-04-24`:

| Leg | 4h candles | history start | days |
|---|---:|---|---:|
| AMZNUSDT | 1000 | 2026-02-14 | 167 |
| TSLAUSDT | 1000 | 2026-02-14 | 167 |
| MUUSDT | 803 | 2026-03-19 | 134 |
| INTCUSDT | 586 | 2026-04-24 | 98 |
| SOXLUSDT | 443 | 2026-05-18 | 74 |
| IBMUSDT | 346 | 2026-06-03 | 58 |
| RIVNUSDT | 304 | 2026-06-10 | 51 |
| BABAUSDT | 263 | 2026-06-17 | 44 |

The window where **all eight legs exist simultaneously is 2026-06-17 → 2026-07-30 — 43 days.**
A 1-year stamp including stocks is not currently possible at any level of effort. It is a data problem.

This also means the headline book run is **ragged**: the backtest was launched on 2026-03-19 with
`skipMissingSymbols: true`, so five legs join partway through. The `+47.15%` is earned by a book whose
composition changes from 1 leg to 8 legs over its own lifetime.

---

## 4. Question 3 — How to re-sum correctly, and what capital to show

### Capital semantics: `capital_weight 0.5` vs `initial 5000`

These are the same statement in two units, and both are correct — **but only if the client's deposit grows.**

`capital_weight` is *not* a fraction of a fixed pot. Tracing it through materialization:

```19256:19256:backend/src/saas/service.ts
          memberWeightScale: Math.max(0.05, asNumber(member.capital_weight, 1)),
```

```15334:15337:backend/src/saas/service.ts
  const weightScale = Math.max(0.05, Math.min(10, asNumber(options?.memberWeightScale, 1)));
  let members: TradingSystemMemberDraft[] = uniqueMaterialized.map((row, index) => ({
    strategy_id: Number(row.strategyId),
    weight: Number(((index === 0 ? 1.25 : index === 1 ? 1.1 : 1) * Math.max(0.25, riskMultiplier) * weightScale).toFixed(4)),
```

It is a **lot-size multiplier**, denominated in $10k units. It does not reserve or ring-fence capital, and
nothing normalizes the weights to sum to 1. So attaching `stocks 0.5` to a portfolio that was `b3 1.0 + mrs 1.0`
does not carve $5k out of $20k — **it adds 25% more gross exposure on top of the same account.**

This is where the research and production diverge, and it is the reason the `ΔDD` column is misleading.

### The `ΔDD −2.6pp` improvement is mostly denominator inflation, not diversification

`combineBooks` sums independent book curves and divides by the sum of their starting capitals. Adding a
$5 000 low-DD book to a $20 000 higher-DD portfolio mechanically reduces percentage DD because the
denominator grew 25% while the added book contributed almost none of the drawdown. That is arithmetic,
not correlation benefit. The honest framing is:

- **If the client adds $5 000** → `43.24% / 9.10%` on $25 000 is a fair statement.
- **If the client does not add money** (which is the current DB state: weights `1.0/1.0/0.5`, snapshot capital
  `20 000`) → they are running the $25 000 recipe on a $20 000 account, i.e. **~1.25× the intended leverage**,
  and both return and drawdown scale up roughly proportionally. Expected DD lands near `11.4%`, i.e. no
  improvement over the `11.74%` "before" at all.

### Correct procedure to re-sum without lying

1. **Pick one window and run every book in it.** No splicing, no annualizing, no mixing a 350-day crypto
   curve with a 133-day equity curve.
2. **Use one cost model across all books.** Today B3 runs at `comm 0.1 / slip 0.05` while MRS and stocks
   run at `comm 0.036 / slip 0`. The stocks sleeve is being graded on an easier exam than B3 inside the
   very same comparison table. Re-run everything at B3's cost assumptions at minimum.
3. **Decide the capital question explicitly and write it into `metadata.books`.** Either
   (a) **capital grows**: add `{"key":"stocks","initial":5000,"op":6,"lot":15,"ri":100}` to
   `metadata.books`, bump `snapshot.capital` to 25 000 / 25 000 / 35 000 / 25 000 / 30 000 / 35 000, and raise the
   advertised minimum deposit; or
   (b) **capital is constant**: rescale weights so they still total the old number (conservative
   `b3 0.8 / mrs 0.8 / stocks 0.4`), which preserves the `43.24% / 9.10%` percentages while keeping a
   $20 000 account. **Option (b) is the honest default**, because clients will not top up on request.
   Doing neither — which is today's state — is the one option that is actively wrong.
4. **Fix the `booksMeta` lookup before re-running anything**, or the rerun will keep emitting `op=0 lot=0 cap=4000`.
5. **Label the window on the artifact.** `snapshot_json` currently has `dateFrom`/`dateTo` **empty** while
   advertising `ret = 1264.99%` (conservative) and `4640.9%` (aggressive). An unbounded four-digit return with
   no window is the most dangerous string on the storefront, entirely independent of the stocks question.

---

## 5. Question 4 — Live legs are idle. Does that invalidate the +47% claim?

**Yes, and this is stronger evidence than any backtest critique.**

Contrary to the premise that nothing was materialized: **10 client keys × 8 legs = 80 live stock strategies
are active and runtime-enabled** (`Copy_Alex1`, `arcopy1`, `icopy1`, `mikitamikado`, and six `artursk-*` keys).
The master strategies are correctly inactive; the client copies are live.

In the ~10 days since materialize, `live_trade_events` contains **15 rows total** on stock symbols — and that
count includes both `strategy_signal` and `exchange_fill` rows, so it is **at most ~6 completed round trips
across all 10 clients combined.**

The backtest claims 743 trades over 133 days = **5.6 trades/day per book**. Ten days should have produced
roughly 56 round trips *per client*. Observed: under 1 per client. That is a **~99% frequency shortfall.**

A backtest that fires 100× more often than the live engine is not modeling the live engine. Until that gap is
explained, `+47.15%` describes a system that does not exist in production. Three things fall out of the fill log:

**(a) Slippage is catastrophic relative to the edge.** The one clean signal→fill pair:

| event | time | price |
|---|---|---:|
| SOXLUSDT short, `strategy_signal` | 2026-07-31 20:18:25 | 118.79 |
| SOXLUSDT short, `exchange_fill` | 2026-07-31 20:41:01 | 114.51 |

23 minutes of latency and a **3.6% adverse move** on entry. The strategy's entry threshold is a **0.2% MA shift**.
The execution error is **18× the signal**. The backtest models `slippagePercent: 0`. Note also that the
`slippage_percent` column recorded `0.0` for this fill — the slippage telemetry is not being populated, so this
would never have surfaced on a dashboard.

**(b) Position reconciliation is broken.** Four clients logged an `entry` and an `exit` on RIVNUSDT at the
*identical second* (e.g. `00:24:32`, `00:27:37`, `00:30:16`, `00:44:50`). And `artursk-1717746786` entered
`4.2` at 00:20:28 and exited **`162.8`** at 00:47:46 — a 39× size mismatch. This needs its own investigation
and is a live-risk item, not a research item.

**(c) Liquidity does not exist at the modeled size.** Median 4h bar volume from the candle bundle:
AAPL 10, TSLA 23, NVDA 38, AMZN 150, IBM 257, BABA 254. At lot 15% × leverage 20 on a $5 000 book, a single
position is ~$15 000 notional — **multiples of an entire 4h bar's traded volume** on several of these legs.
Zero modeled slippage on a book that turns over 743 times in that order book is not a conservative
assumption; it is a fictional one.

---

## 6. Question 6 — The dump-stress claim is invalid. `SPXUSDT` is a memecoin.

**"Sleeve +8.97% while SPX −37.76%" must be deleted from every artifact immediately.**

The stress window is chosen by scanning `results/hybrid_candle_bundle_weex_stocks/4h/SPXUSDT.json` for the
worst 30-day close-to-close move. That file's price series:

- first candle 2026-02-14: close **0.3254**
- last candle 2026-07-30: close **0.3324**
- range over the file: **0.2576 – 0.4864**
- the "crash": 2026-05-11 close **0.4864** → 2026-06-10 close **0.2986**

The S&P 500 trades near 6 000. An instrument oscillating between **$0.26 and $0.49** is **SPX6900, the
memecoin**, which WEEX lists as `SPXUSDT`. It was swept into the `API_OK` "stocks" universe purely on ticker
string match, and it also entered the screen as a tradable candidate (it scored `−0.76%` and was dropped, so
it is not in the sleeve — but it *defined the stress window*).

Consequences:

1. There is **no equity-crash stress test.** The −37.76% event is a memecoin drawdown with no causal
   relationship to MU, IBM, AMZN or TSLA.
2. The window `2026-05-11 → 2026-06-10` was selected by a variable unrelated to the sleeve, so the
   `+8.97%` is a **random 30-day slice**, not an adverse scenario.
3. Even taken at face value it is **in-sample**: the window sits inside `2026-03-19 → 2026-07-30`, the same
   period used to pick every leg's parameters. The sleeve was tuned with knowledge of that month.
4. It was run on **4–5 legs, not 8** — IBM (from 06-03), RIVN (06-10) and BABA (06-17) did not exist yet.
   `skippedOP: 0` confirms the book never hit its position limit, i.e. it was running well under capacity.

Survivor bias, short sample, and wrong benchmark all at once. This is the single most quotable and most
indefensible number in the package.

---

## 7. Question 5 — Overfitting risk of len 2–3 / 0.2%

The risk is severe and the selection procedure has no out-of-sample step anywhere.

**The grid has only 4 cells** (`len ∈ {2,3} × shift ∈ {0.2%, 0.5%}`), and **all 8 selected legs chose
`shift = 0.2%`** — the tightest value, unanimously, at the edge of the grid. When every winner lands on
a boundary, the grid did not find an optimum; it found the direction of more trades. A 2–3 bar moving
average with a 0.2% band is, functionally, a coin-flip generator with a transaction-cost drag.

**The selection is pure in-sample cherry-picking.** From the screen of 12 symbols, the filter
(`ret > 0 && dd <= 12 && trades >= 20 && pf >= 1.05`) admitted exactly the **8 symbols that made money**,
and rejected the 4 that lost (AVGO −0.03%, SPX −0.76%, UBER −2.25%, NVDA −1.25%). Then the book was
backtested on **the same window** used to choose them. There is no holdout, no walk-forward, no
parameter-stability check — unlike the MRS book, which does have a WF artifact
(`weex_mrs_engine_wf_postfill.json`). The stocks sleeve was held to a visibly lower standard.

**Legs are ranked against each other on incomparable windows.** The screen runs each symbol on
`meta.from → meta.to`, i.e. its own history. `SOXLUSDT +12.22%` is over **74 days**; `MUUSDT +12.25%` is over
**134 days**. They were scored side by side as if equal. This systematically promotes short-history legs,
which are exactly the legs with the least evidence — and 5 of the 8 selected have under 100 days.

**The signal sits far inside the noise.** Median absolute 4h close-to-close move per leg: SOXL **1.69%**,
INTC 0.78%, MU 0.75%, RIVN 0.38%, TSLA 0.34%, BABA 0.34%, IBM 0.36%, AMZN 0.24%. A 0.2% entry band is
between **1/8 and 1/1.2** of a typical bar. The strategy is trading inside the bid-ask/noise envelope.

**`+47.15%` is a leverage artifact, not eight diversified edges.** The individual legs returned
0.38% to 12.25% on standalone $3 000 books (sum 40.93%, mean 5.1%). The sleeve compresses all eight
into a single **$5 000** book at lot 15% with `reinvest 100`. Capital deployed drops from $24 000 to $5 000
(4.8×) while return jumps 9×. The sleeve is the same weak signals run at roughly five times the capital
intensity. Its `DD 8.71%` therefore carries the same 5× amplification on the downside — and that estimate
is in-sample, on a book that spent much of the window under-populated.

---

## 8. What is not stamped / misleading on the storefront

| # | Issue | Severity |
|---|---|---|
| 1 | `snapshot.ret` of 1264.99% / 4640.9% with **empty `dateFrom`/`dateTo`** | Critical |
| 2 | Members = 3 (incl. stocks) but `metadata.books` = 2 and capital = 2-book value | Critical |
| 3 | Portfolio rerun yields `op=0 lot=0 ri=0 cap=$4000` for the stocks book | Critical |
| 4 | "SPX −37.76%" benchmark is the SPX6900 memecoin | Critical |
| 5 | 80 live legs deployed at ~1% of backtested trade frequency | Critical |
| 6 | Stocks weight adds 25% gross exposure without a capital increase | High |
| 7 | Sleeve graded at `comm 0.036 / slip 0` while B3 in the same table pays `0.1 / 0.05` | High |
| 8 | Sleeve attached to **all** `is_enabled=1` portfolios, including personal whale, unreviewed | Medium |
| 9 | `recipes.json` `sharedB3.ri = 50` vs stamped `reinvest: 0` | Medium |
| 10 | `slippage_percent` telemetry writes `0.0` even on a 3.6% deviation | Medium |

---

## 9. Recommended stamp IF we only have Mar–Jul data

Publish it as a clearly labelled **short-window** result. Never as an update to the 1y card, never annualized,
and never on the same axis as the 1y number.

> **Real BT — short window, 2026-03-19 → 2026-07-30 (133 days / 4.4 months).**
> Not annualized. Stocks sleeve has under 5 months of market history; three of eight legs have under 60 days.
> Shown alongside, not instead of, the 1-year b3+mrs result.

| Portfolio | Capital | Ret (133d) | Max DD |
|---|---:|---:|---:|
| Conservative | $25 000 | +43.24% | 9.10% |
| Balanced | $25 000 | +42.31% | 8.86% |
| Aggressive | $35 000 | +31.81% | 8.42% |
| Quality Tilt | $25 000 | +38.53% | 8.34% |
| Triple | $30 000 | +49.80% | 10.86% |

**Conditions, all of which must be met before these go on the storefront:**

1. Re-run with a **single cost model** across all books (B3's `comm 0.1 / slip 0.05` as the floor) and add a
   slippage assumption for stocks that is defensible against the observed 3.6% live deviation. **Expect these
   numbers to fall materially — the stocks contribution may not survive at all.**
2. Choose capital option (a) or (b) from §4 and make `metadata.books`, `snapshot.capital` and
   `capital_weight` agree with each other.
3. Delete the dump-stress line entirely, or re-run it against a real equity benchmark on a window that is
   *not* inside the parameter-selection period.
4. Publish the trade-count reconciliation: backtested trades/day vs live trades/day per leg. If the live
   engine still fires at 1% of backtest, the sleeve should be **disabled, not stamped.**
5. State the ragged-start caveat: the book runs 1→8 legs over its own lifetime.

**If you want a number you can defend today with zero further work, publish the 1y b3+mrs stamp unchanged
and describe the stocks sleeve as "in live pilot, unstamped".** That is accurate, it is already true, and it
costs nothing.

---

## 10. Red flags for HF-grid / micro-stop ideas

Anything in this direction is currently blocked by execution reality, not by strategy design:

1. **23-minute signal→fill latency with 3.6% drift.** Any concept whose per-trade edge is under ~4% is noise
   at the current execution path. HF grids live on edges of 0.1–0.5%. The margin is negative by an order of magnitude.
2. **Micro-stops sit inside a single bar.** A 0.2–0.5% stop against median 4h moves of 0.24–1.69% will be
   swept constantly. On SOXL the stop is ~1/8 of a typical bar; it is not a stop, it is a random exit.
3. **The order books are empty.** Median 4h volume of 10 (AAPL), 23 (TSLA), 38 (NVDA) units. A grid strategy
   is a liquidity *provider* — into this depth it is pure adverse selection, filled only when wrong.
4. **Fee-to-edge ratio.** Round-trip cost ~0.072% modeled (~0.1% realized). A 0.2% grid step nets ~0.1% before
   any slippage; one 3.6% slip erases 36 winning trades.
5. **Bar-close execution is structurally incompatible with HF.** The runtime evaluates on candle close.
   On 4h bars you get 6 decisions/day. "High frequency" is not available at this architecture.
6. **Zero-slippage backtesting will make every HF idea look brilliant.** Every such proposal must be
   re-scored at ≥0.5% slippage before it is discussed. If it does not survive, it does not get built.
7. **Overfitting scales with grid density.** The current 4-cell grid already pinned every leg to a boundary
   value. A denser HF grid on ≤134 days of data will fit noise with near-certainty. Any future sweep needs
   walk-forward with a genuine holdout, matching the standard already applied to the MRS book.

---

## 11. Immediate actions (no live trading changes required)

**Do first, in order:**

1. **Fix the `booksMeta` lookup** in `service.ts` so a member without a matching book entry raises an error
   instead of silently defaulting to `op=0 lot=0 cap=proportional`. Today it fails quietly.
2. **Add `dateFrom`/`dateTo` to every `snapshot_json`.** A 4640.9% return with no window is the largest
   standing liability on the storefront.
3. **Purge the "SPX −37.76%" line** from `stock_sleeve_shortma.json`, the compare `.md`/`.json`, and the
   master card metadata.
4. **Reconcile members vs books** for all six portfolios — either add the stocks book to metadata or remove
   the member. The current half-state is worse than either.

**Investigate separately (live-risk, outside this review's scope):**

5. The RIVNUSDT same-second entry/exit pairs and the 4.2 → 162.8 size mismatch.
6. Why 80 live legs produced ~6 round trips in 10 days when the backtest implies ~560.
7. Why `slippage_percent` logs `0.0` on a fill that deviated 3.6% from its signal.
