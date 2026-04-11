import re
LOG = '/opt/battletoads-double-dragon/backend/logs/combined.log'
with open(LOG, 'rb') as f:
    f.seek(0, 2)
    size = f.tell()
    f.seek(-200000, 2)
    raw = f.read().decode('utf-8', errors='replace')

lines = raw.splitlines()
print(f"Total lines in last 200KB: {len(lines)}")
print("\n--- First 5 lines ---")
for l in lines[:5]:
    print(repr(l[:200]))

print("\n--- Lines with 'cycle' or 'autorun' ---")
cnt = 0
for l in lines:
    if 'cycle' in l.lower() or 'autorun' in l.lower():
        print(repr(l[:200]))
        cnt += 1
        if cnt >= 5:
            break

print("\n--- Lines with timestamp samples (last 5) ---")
ts_lines = [l for l in lines if re.match(r'\d{4}-\d{2}-\d{2}', l[:20])]
for l in ts_lines[-5:]:
    print(repr(l[:200]))
