import json, subprocess

cfg_path = '/opt/battletoads-double-dragon/backend/razgon_config.json'

with open(cfg_path) as f:
    cfg = json.load(f)

# Disable all razgon engines
cfg['momentum']['enabled'] = False
cfg['sniper']['enabled'] = False
cfg['funding']['enabled'] = False

# Disable all api key entries
for k in cfg.get('apiKeys', []):
    k['enabled'] = False

with open(cfg_path, 'w') as f:
    json.dump(cfg, f, indent=2)

print("razgon_config.json updated — all engines disabled")
print(f"  momentum.enabled = {cfg['momentum']['enabled']}")
print(f"  sniper.enabled   = {cfg['sniper']['enabled']}")
print(f"  funding.enabled  = {cfg['funding']['enabled']}")
for k in cfg.get('apiKeys', []):
    print(f"  apiKey {k['name']} enabled = {k['enabled']}")

# Restart btdd-api
result = subprocess.run(['systemctl', 'restart', 'btdd-api'], capture_output=True, text=True)
if result.returncode == 0:
    print("\nbtdd-api restarted OK")
else:
    print(f"\nbtdd-api restart error: {result.stderr}")

# Show status
result2 = subprocess.run(['systemctl', 'is-active', 'btdd-api'], capture_output=True, text=True)
print(f"btdd-api status: {result2.stdout.strip()}")
result3 = subprocess.run(['systemctl', 'is-active', 'btdd-runtime'], capture_output=True, text=True)
print(f"btdd-runtime status: {result3.stdout.strip()}")
