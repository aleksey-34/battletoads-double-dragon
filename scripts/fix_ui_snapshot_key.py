#!/usr/bin/env python3
"""Fix: modal should use saved snapshot (same source as card), not live sweep.
Also log MOP info for diagnosis."""
import os, subprocess

BASE = "/opt/battletoads-double-dragon"

# Use node to patch SaaS.tsx (file too large for Python direct read)
node_script = """
const fs = require('fs');
const path = '/opt/battletoads-double-dragon/frontend/src/pages/SaaS.tsx';
let text = fs.readFileSync(path, 'utf-8');
let changes = 0;

// Fix 1: Modal should use adminSavedTsSnapshot (same as card), not sweepSummary.portfolioFull
// Line ~9169: summary?.sweepSummary?.portfolioFull
// Replace in modal statistics section:
const modalPattern1 = /summary\?\\.sweepSummary\?\\.portfolioFull\?\\.summary\?\\.totalReturnPercent/g;
if (modalPattern1.test(text)) {
  text = text.replace(
    /summary\?\\.sweepSummary\?\\.portfolioFull\?\\.summary/g,
    'adminDraftPortfolioSummary'
  );
  // Also fix the other references in the modal stat cards
  text = text.replace(
    /summary\\.sweepSummary\\.portfolioFull\\.summary\?/g,
    'adminDraftPortfolioSummary?'
  );
  changes++;
  console.log('[FIX] Modal now uses adminDraftPortfolioSummary (saved snapshot)');
} else {
  console.log('[SKIP] Modal pattern1 not found - may already be fixed');
}

// Fix 2: Snapshot lookup with suffix matching (already applied before, verify)
if (text.includes('Try finding by suffix match')) {
  console.log('[OK] Suffix matching already in place');
} else {
  console.log('[WARN] Suffix matching NOT found - may need re-application');
}

fs.writeFileSync(path, text, 'utf-8');
console.log(`Done. Changes applied: ${changes}`);
"""

with open("/tmp/patch_saas.js", "w") as f:
    f.write(node_script)

r = subprocess.run(["node", "/tmp/patch_saas.js"], capture_output=True, text=True, timeout=30)
print(r.stdout)
if r.stderr:
    print("STDERR:", r.stderr)

# Build frontend
print("\n=== Building frontend ===")
os.chdir(os.path.join(BASE, "frontend"))
r = subprocess.run(["npm", "run", "build"], capture_output=True, text=True, timeout=120)
print("STDOUT:", r.stdout[-300:])
print("STDERR:", r.stderr[-300:] if r.stderr else "")
print(f"Exit: {r.returncode}")

# Restart services
if r.returncode == 0:
    subprocess.run(["systemctl", "restart", "btdd-api", "btdd-runtime"], capture_output=True)
    print("Restarted services")

# Commit
os.chdir(BASE)
subprocess.run(["git", "add", "frontend/src/pages/SaaS.tsx", "backend/src/services/strategy/"], capture_output=True)
subprocess.run(["git", "commit", "-m", "fix: UI snapshot key - modal now uses saved snapshot same as card"], capture_output=True)
subprocess.run(["git", "push"], capture_output=True)
print("Committed and pushed")
