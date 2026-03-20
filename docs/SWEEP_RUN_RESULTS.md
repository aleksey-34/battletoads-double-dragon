# Sweep Run Results Log

## Goal
Track each major sweep/backfill run with reproducible metrics for:
- strategy ranking,
- offer generation,
- product-level rollout decisions.

## Run Template
- Run ID:
- Started at (UTC):
- Finished at (UTC):
- Mode: light | heavy
- Scope: missing days / full recompute / manual pair batch
- Requested days:
- Analyzed days:
- Missing days before:
- Processed days:
- Created runs:
- Skipped days:
- Failure count:
- ETA behavior (stable/unstable):

### Data Quality Checks
- Sweep artifacts persisted: yes/no
- Progress checkpoints persisted: yes/no
- Last processed day key:
- Any gaps left:

### Ranking Output (Top candidates)
- Top by PF:
- Top by Sharpe proxy / stability:
- Top by DD control:
- Top by trades/day rhythm:
- Top balanced (PF + DD + WR + trades):

### Offer Candidates
- Mono offers shortlist:
- Synth offers shortlist:
- Recommended product mapping:
  - Strategy Client:
  - Algofund:

### Trading System Candidates
- TS-1 (balanced):
- TS-2 (high-frequency):
- TS-3 (conservative):

### Admin Decision
- Promote to runtime: yes/no
- Reason:
- Follow-up tasks:
