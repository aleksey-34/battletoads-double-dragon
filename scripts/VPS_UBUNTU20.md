# VPS Deployment (Ubuntu 20.04)

## Important

Copy only commands from code blocks.
Do not paste shell prompts (`user@host:~$`, `root@host:~#`) and do not paste command output back into terminal.
Do not use `<owner>/<repo>` in shell commands. Use real values without `<` and `>`.

## Works Without Laptop

After deployment to VPS, the bot runs as a `systemd` service (`battletoads-backend`) on the server.
Your laptop may be turned off; VPS keeps running 24/7.

Useful checks on VPS:

```bash
sudo systemctl status battletoads-backend --no-pager
sudo journalctl -u battletoads-backend -n 120 --no-pager
sudo systemctl restart battletoads-backend
```

## Where to get REPO_URL

If project already has Git remote:

```bash
git remote get-url origin
```

Create repo in your currently authenticated GitHub account (recommended):

```bash
cd /home/yakovbyakov/BattleToads_DoubleDragon/battletoads-double-dragon
chmod +x scripts/create_github_repo.sh
bash scripts/create_github_repo.sh battletoads-double-dragon private main
```

If `gh` is missing:

```bash
sudo apt install gh
gh auth login
```

Then run `scripts/create_github_repo.sh` again.

If you see `fatal: not a git repository`, initialize and push project first:

```bash
cd /home/yakovbyakov/BattleToads_DoubleDragon/battletoads-double-dragon
git init
git add .
git commit -m "chore: initial verified release"
git branch -M main
git remote add origin https://github.com/aleksey-34/battletoads-double-dragon.git
git push -u origin main
```

Or use helper script:

```bash
cd /home/yakovbyakov/BattleToads_DoubleDragon/battletoads-double-dragon
bash scripts/bootstrap_git_repo.sh https://github.com/aleksey-34/battletoads-double-dragon.git main
```

After push, your `REPO_URL` is:

- `https://github.com/aleksey-34/battletoads-double-dragon.git`

## PRIVATE repo access for VPS

Current repo visibility: `PRIVATE`.
VPS cannot clone private repo without credentials.

Option A (simplest): make repository public

```bash
gh repo edit aleksey-34/battletoads-double-dragon --visibility public --accept-visibility-change-consequences
```

Option B: keep private and use token URL in setup/deploy

```bash
REPO_URL="https://<GITHUB_TOKEN>@github.com/aleksey-34/battletoads-double-dragon.git"
```

Token should have scope: `repo`.

Recommended periodic verified releases:

```bash
git add .
git commit -m "release: stable update"
git tag -a vYYYY.MM.DD.N -m "verified VPS release"
git push origin main --tags
```

## Fast path: Termius + FileZilla (install to /opt)

### 1) On local machine: build package

```bash
cd /home/yakovbyakov/BattleToads_DoubleDragon/battletoads-double-dragon
bash scripts/build_vps_package.sh
ls -1t scripts/dist/btdd_vps_git_bundle_*.tar.gz | head -n 1
```

### 2) Upload package with FileZilla

- Protocol: `SFTP`
- Host: your VPS IP
- User: `root`
- Remote folder: `/root`
- Upload file: latest `btdd_vps_git_bundle_*.tar.gz`

### 3) Run setup in Termius (on VPS)

```bash
cd /root
PKG="$(ls -1t btdd_vps_git_bundle_*.tar.gz | head -n 1)"
echo "$PKG"
tar -xzf "$PKG"
cd "${PKG%.tar.gz}"
REPO_URL="https://github.com/aleksey-34/battletoads-double-dragon.git"
DOMAIN=176.57.184.98 ADMIN_PASSWORD='strong-password' bash setup_vps_ubuntu20.sh "$REPO_URL" /opt/battletoads-double-dragon main
```

If your Termius session may disconnect, run setup in background with log:

```bash
cd /root
PKG="$(ls -1t btdd_vps_git_bundle_*.tar.gz | head -n 1)"
DIR="${PKG%.tar.gz}"
rm -rf "$DIR"
tar -xzf "$PKG"
cd "$DIR"
REPO_URL="https://github.com/aleksey-34/battletoads-double-dragon.git"
nohup env DOMAIN=176.57.184.98 ADMIN_PASSWORD='strong-password' \
	bash ./setup_vps_ubuntu20.sh "$REPO_URL" /opt/battletoads-double-dragon main \
	> /root/btdd_setup.log 2>&1 &

tail -n 80 /root/btdd_setup.log
```

Check progress later:

```bash
tail -f /root/btdd_setup.log
```

If your repository is private, use URL with access token or SSH URL with configured deploy key.

### 4) Verify services

```bash
sudo systemctl status battletoads-backend --no-pager
sudo systemctl status nginx --no-pager
sudo ss -ltnp | grep -E ':80|:3001'
curl -I http://127.0.0.1
```

### 5) Open frontend

- Browser URL: `http://176.57.184.98/`
- Login password: same value as `ADMIN_PASSWORD` from setup command.

## Reset dashboard password (VPS)

If dashboard password is lost, reset hash in backend env and restart service.

```bash
NEW_PASSWORD='KU#HFSyw3geys2ska#FYE'
APP_DIR='/opt/battletoads-double-dragon'
HASH="$(cd "$APP_DIR/backend" && node -e "const bcrypt=require('bcrypt'); console.log(bcrypt.hashSync(process.argv[1], 10));" "$NEW_PASSWORD")"
sudo sed -i "s|^PASSWORD_HASH=.*|PASSWORD_HASH=${HASH}|" /etc/battletoads-backend.env
sudo rm -f "$APP_DIR/backend/.auth-password.json"
sudo systemctl restart battletoads-backend.service
sudo systemctl status battletoads-backend --no-pager
```

After restart, login with `NEW_PASSWORD`.

## Telegram password recovery setup

The login page supports password recovery by one-time code sent to Telegram.

```bash
sudo tee -a /etc/battletoads-backend.env >/dev/null <<'EOF'
RECOVERY_TELEGRAM_BOT_TOKEN=<telegram_bot_token>
RECOVERY_TELEGRAM_CHAT_ID=<telegram_chat_id>
RECOVERY_CODE_TTL_MIN=10
RECOVERY_COOLDOWN_SEC=60
RECOVERY_MAX_ATTEMPTS=5
EOF

sudo systemctl restart battletoads-backend.service
```

Hints:
- Create bot via `@BotFather`, copy token.
- For personal chat id use helper bot like `@userinfobot`.
- For group chat id, add bot to group and query updates via Telegram API.

## Daily Update Workflows

Current production-like branch in this repository:

- `feature/tv-engine-refactor`

Main unified launcher:

- local repo: `./deploy.sh`
- VPS repo: `/opt/battletoads-double-dragon/deploy.sh`

### A. Recommended: update from local machine through Git

Use this when changes are already committed or should become the new canonical Git state.

1) Commit and push from local machine:

```bash
cd /home/yakovbyakov/BattleToads_DoubleDragon/battletoads-double-dragon
git status --short
git add .
git commit -m "fix: describe your update"
git push origin feature/tv-engine-refactor
```

2) Deploy that branch to VPS from local machine:

```bash
cd /home/yakovbyakov/BattleToads_DoubleDragon/battletoads-double-dragon
bash ./deploy.sh local root@176.57.184.98 feature/tv-engine-refactor /opt/battletoads-double-dragon
```

If current local branch is already the correct one and default host/path are fine:

```bash
cd /home/yakovbyakov/BattleToads_DoubleDragon/battletoads-double-dragon
bash ./deploy.sh local
```

### B. Fast temporary update: deploy current local tree without commit

Use this when the newest fixes are only local and you need them on VPS immediately.

```bash
cd /home/yakovbyakov/BattleToads_DoubleDragon/battletoads-double-dragon
bash ./deploy.sh local-tree root@176.57.184.98 /opt/battletoads-double-dragon
```

This syncs the current workspace to VPS with `rsync`, then builds backend/frontend there and restarts services.

Important:

- this path is good for emergency verification
- later you should still commit and push, otherwise future Git-based updates may overwrite those VPS-only synced changes

### C. Update directly on VPS

Use this when the target commit is already in Git and the VPS only needs pull/build/restart.

```bash
sudo bash /opt/battletoads-double-dragon/deploy.sh vps feature/tv-engine-refactor /opt/battletoads-double-dragon
```

Direct fallback without wrapper:

```bash
sudo APP_DIR=/opt/battletoads-double-dragon BRANCH=feature/tv-engine-refactor \
bash /opt/battletoads-double-dragon/scripts/update_vps_from_git.sh
```

### D. Install a short VPS command once

```bash
sudo bash /opt/battletoads-double-dragon/deploy.sh install-bin
sudo btdd-deploy vps feature/tv-engine-refactor /opt/battletoads-double-dragon
```

This creates:

- `/usr/local/bin/btdd-deploy` -> `/opt/battletoads-double-dragon/deploy.sh`

### E. Verify deployed revision

From local machine:

```bash
ssh root@176.57.184.98 "git -C /opt/battletoads-double-dragon log --oneline -n 3"
ssh root@176.57.184.98 "systemctl status battletoads-backend.service --no-pager | head -n 30"
ssh root@176.57.184.98 "journalctl -u battletoads-backend.service -n 120 --no-pager"
```

Or directly on VPS:

```bash
git -C /opt/battletoads-double-dragon log --oneline -n 3
systemctl status battletoads-backend.service --no-pager | head -n 30
journalctl -u battletoads-backend.service -n 120 --no-pager
```

## First Start (Git-based, minimal)

1) Push your current code to Git (`main` or target branch).
2) Run setup on VPS:

```bash
cd /root
SETUP_SCRIPT="$(find /root -maxdepth 3 -type f -name setup_vps_ubuntu20.sh | head -n 1)"
echo "$SETUP_SCRIPT"
REPO_URL="https://github.com/aleksey-34/battletoads-double-dragon.git"
DOMAIN=176.57.184.98 ADMIN_PASSWORD='strong-password' bash "$SETUP_SCRIPT" "$REPO_URL" /opt/battletoads-double-dragon main
```

3) Verify env for UI Git Update API:

```bash
sudo grep -E 'ENABLE_GIT_UPDATE|APP_DIR|GIT_BRANCH|UPDATE_SCRIPT' /etc/battletoads-backend.env
```

Expected values:
- `ENABLE_GIT_UPDATE=1`
- `APP_DIR=/opt/battletoads-double-dragon`
- `GIT_BRANCH=main`
- `UPDATE_SCRIPT=/opt/battletoads-double-dragon/scripts/update_vps_from_git.sh`

4) Restart backend once after env check:

```bash
sudo systemctl restart battletoads-backend.service
sudo systemctl status battletoads-backend --no-pager
```

5) Open UI: `http://176.57.184.98/`, login with `ADMIN_PASSWORD`, then open `/saas`.

## Git Update Buttons In /saas

Each tab now has its own Git update controls:
- `Admin` tab: full status + pending commits + job logs.
- `Strategy Client` tab: check/update/job controls + status tags.
- `Algofund` tab: check/update/job controls + status tags.

Recommended click order in any tab:
1) `Check updates`
2) if status shows `Update available`, click `Install from Git`
3) click `Refresh job` and wait until job is finished

If UI shows `ahead` or `dirty`, clean VPS repo state first (or reset to clean Git state) before running update.

## /saas Git Update Buttons

The frontend update controls work only if backend env points to the correct app dir, branch, and update script.

Check on VPS:

```bash
sudo grep -E 'ENABLE_GIT_UPDATE|APP_DIR|GIT_BRANCH|UPDATE_SCRIPT' /etc/battletoads-backend.env
```

Expected values for this project right now:

- `ENABLE_GIT_UPDATE=1`
- `APP_DIR=/opt/battletoads-double-dragon`
- `GIT_BRANCH=feature/tv-engine-refactor`
- `UPDATE_SCRIPT=/opt/battletoads-double-dragon/scripts/update_vps_from_git.sh`

If branch/path are wrong, fix them and restart backend:

```bash
sudo sed -i 's|^ENABLE_GIT_UPDATE=.*|ENABLE_GIT_UPDATE=1|' /etc/battletoads-backend.env
sudo sed -i 's|^APP_DIR=.*|APP_DIR=/opt/battletoads-double-dragon|' /etc/battletoads-backend.env
sudo sed -i 's|^GIT_BRANCH=.*|GIT_BRANCH=feature/tv-engine-refactor|' /etc/battletoads-backend.env
sudo sed -i 's|^UPDATE_SCRIPT=.*|UPDATE_SCRIPT=/opt/battletoads-double-dragon/scripts/update_vps_from_git.sh|' /etc/battletoads-backend.env
sudo systemctl restart battletoads-backend.service
```

Then in `/saas`:

1) click `Check updates`
2) if update is available, click `Install from Git`
3) click `Refresh job`
4) verify backend restarted cleanly

## SaaS Smoke Checks After Update

API checks on VPS:

```bash
curl -s http://127.0.0.1:3001/api/saas/admin/summary -H 'Authorization: Bearer YOUR_PASSWORD' | head -c 1000
journalctl -u battletoads-backend.service -n 120 --no-pager
```

Browser checks after deploy:

- open `http://176.57.184.98/`
- login with the existing dashboard password
- open `/saas/admin`
- open `/saas/strategy-client`
- open `/saas/algofund`
- verify pages render and are not blank
- in `Admin`: click `Инициализировать demo tenants`, then `Опубликовать admin TS`
- in `Клиент стратегий`: select `client-bot-01`, assign API key if needed, save, preview, then `Materialize на API key`
- in `Алгофонд`: select `algofund-01`, set API key/risk, save, preview, then send `Запросить старт`
