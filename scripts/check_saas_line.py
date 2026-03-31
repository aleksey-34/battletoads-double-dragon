#!/usr/bin/env python3
# Check SaaS.tsx for the ESLint error at line 3826 col 64
f = open('/opt/battletoads-double-dragon/frontend/src/pages/SaaS.tsx', encoding='utf-8')
lines = f.readlines()
f.close()
print(f'Total lines: {len(lines)}')
print(f'Line 3826: {repr(lines[3825])}')

# Find any > comparison inside JSX-like context
# Look for lines with > that aren't JSX tags
for i, line in enumerate(lines, 1):
    stripped = line.rstrip()
    # Look for bare > in the middle of text-like content
    # Skip lines that are just > (closing JSX)
    # Skip > inside {} or =>
    if '>' in stripped and not stripped.strip().startswith('//'):
        # Check if there's a > that's not => >= >> <> </> />
        import re
        # Find > that's used as comparison in what looks like text node
        if re.search(r'[^=!<>/-] *> *[^=>{\n]', stripped):
            # More specific: not in JS expression inside {}
            # Hard to determine without parsing, but check for bare > in JSX text
            col_pos = stripped.find('>')
            while col_pos != -1:
                before = stripped[:col_pos]
                after = stripped[col_pos+1:]
                # Count braces to see if we're inside {}
                open_b = before.count('{') - before.count('}')
                c = stripped[col_pos-1] if col_pos > 0 else ''
                n = stripped[col_pos+1] if col_pos+1 < len(stripped) else ''
                if open_b <= 0 and c not in '=-!</' and n not in '=>' and n != ' ' and n not in '/{':
                    if 3820 <= i <= 3830:
                        print(f'!! SUSPECT line {i} col {col_pos+1}: {repr(stripped)}')
                col_pos = stripped.find('>', col_pos+1)

print('Done. Checking lines 3820-3830:')
for i in range(3819, 3830):
    print(f'  {i+1}: {repr(lines[i])}')
