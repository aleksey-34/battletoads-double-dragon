#!/usr/bin/env python3
"""Remove the orphaned research-analysis block from SaaS.tsx"""
import sys

path = 'frontend/src/pages/SaaS.tsx'
with open(path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

PLACEHOLDER = 'RESEARCH_ANALYSIS_REMOVED_PLACEHOLDER_DELETE_ME'

# Find start line index of orphaned block
start_idx = None
for i, line in enumerate(lines):
    if PLACEHOLDER in line:
        # Walk back to find the opening { of this tab item
        for j in range(i, max(0, i-5), -1):
            stripped = lines[j].strip()
            if stripped == '{':
                start_idx = j
                break
        if start_idx is None:
            start_idx = i - 1  # fallback
        break

if start_idx is None:
    print("ERROR: Placeholder not found!")
    sys.exit(1)

print(f"Orphaned block starts at line {start_idx+1}: {lines[start_idx].rstrip()}")

# Find end line: look for the key: 'clients', label: 'Клиенты' after the placeholder
# The orphaned block ends with '},\n' just before the real clients tab
end_idx = None
for i in range(start_idx + 1, len(lines)):
    # Look for the real clients label in Russian
    if "label: 'Клиенты'" in lines[i] or 'label: "Клиенты"' in lines[i]:
        # Found the real clients tab - the end of orphaned block is the '},\n' before `{`
        # Walk back to find the `},`
        for j in range(i, max(start_idx, i-5), -1):
            if lines[j].strip() == '{':
                end_idx = j  # real clients block starts here
                break
        break

if end_idx is None:
    print("ERROR: Could not find end of orphaned block!")
    sys.exit(1)

print(f"Orphaned block ends at line {end_idx} (real clients tab starts at {end_idx+1}: {lines[end_idx].rstrip()})")

# Remove lines start_idx to end_idx (exclusive - keep end_idx which is the start of real clients)
new_lines = lines[:start_idx] + lines[end_idx:]
print(f"Removed {end_idx - start_idx} lines")

with open(path, 'w', encoding='utf-8') as f:
    f.writelines(new_lines)

print("Done! File written.")

# Verify
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

if PLACEHOLDER in content:
    print("WARNING: Placeholder still in file!")
else:
    print("Verified: placeholder removed successfully")
    
clients_count = content.count("key: 'clients'")
print(f"'key: clients' count: {clients_count}")
