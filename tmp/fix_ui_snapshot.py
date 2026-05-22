"#!/usr/bin/env python3
import os, sys

path = '/home/yakovbyakov/projects/battletoads-double-dragon/frontend/src/pages/SaaS.tsx'
if not os.path.exists(path):
    print('File not found:', path)
    sys.exit(1)

with open(path, 'r', encoding='utf-8') as f:
    text = f.read()

old_snippet = 'const adminSavedTsSnapshot = useMemo(() => snapshotKeyForCurrentSet'
new_snippet = '''const adminSavedTsSnapshot = useMemo(() => {
    if (!snapshotKeyForCurrentSet) {
      return summary?.offerStore?.tsBacktestSnapshot || null;
    }
    const snapshots = summary?.offerStore?.tsBacktestSnapshots;
    if (!snapshots) return summary?.offerStore?.tsBacktestSnapshot || null;
    // Try exact match first
    if (snapshots[snapshotKeyForCurrentSet]) return snapshots[snapshotKeyForCurrentSet];
    // Try finding by suffix match (short slug stored under full systemName key)
    for (const [key, val] of Object.entries(snapshots)) {
      if (key.endsWith('::' + snapshotKeyForCurrentSet) || key === snapshotKeyForCurrentSet) return val;
    }
    // Fallback to legacy snapshot
    return summary?.offerStore?.tsBacktestSnapshot || null;
  }'''

if old_snippet not in text:
    print('Snippet not found. Checking lines around 3500...')
    lines = text.split('\n')
    for i in range(3499, 3505):
        print(f'L{i+1}: {lines[i][:120]}')
    sys.exit(1)

# Find exact old block
old_block_start = text.find(old_snippet)
old_block_end = text.find('\n  [snapshotKeyForCurrentSet, summary?.offerStore?.tsBacktestSnapshots, summary?.offerStore?.tsBacktestSnapshot]);', old_block_start)
if old_block_end == -1:
    print('Could not find end of block')
    sys.exit(1)
old_block = text[old_block_start:old_block_end]

# Replace
text = text.replace(old_block, new_snippet, 1)

with open(path, 'w', encoding='utf-8') as f:
    f.write(text)

print('[OK] UI Snapshot Key fix applied successfully')
"