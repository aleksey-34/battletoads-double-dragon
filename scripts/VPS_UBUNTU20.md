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

## Update from Git later

```bash
sudo APP_DIR=/opt/battletoads-double-dragon BRANCH=main bash /opt/battletoads-double-dragon/scripts/update_vps_from_git.sh
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

## Alternative: one-command deploy from local machine

```bash
cd /home/yakovbyakov/BattleToads_DoubleDragon/battletoads-double-dragon
ADMIN_PASSWORD='strong-password' bash scripts/deploy_vps_from_local.sh root@176.57.184.98 https://github.com/aleksey-34/battletoads-double-dragon.git 176.57.184.98 main /opt/battletoads-double-dragon
```

Optional SSH key/port:

```bash
SSH_OPTS='-i ~/.ssh/id_rsa -p 22' ADMIN_PASSWORD='strong-password' bash scripts/deploy_vps_from_local.sh root@176.57.184.98 https://github.com/aleksey-34/battletoads-double-dragon.git 176.57.184.98 main /opt/battletoads-double-dragon
```

## Alternative: deploy current local working tree without commit

Use this when the newest changes are only in the local workspace and are not pushed to Git yet.

```bash
cd /home/yakovbyakov/BattleToads_DoubleDragon/battletoads-double-dragon
bash scripts/deploy_vps_current_tree.sh root@176.57.184.98 /opt/battletoads-double-dragon
```

Optional SSH key/port:

```bash
cd /home/yakovbyakov/BattleToads_DoubleDragon/battletoads-double-dragon
SSH_OPTS='-i ~/.ssh/id_rsa -p 22' bash scripts/deploy_vps_current_tree.sh root@176.57.184.98 /opt/battletoads-double-dragon
```

Post-deploy SaaS smoke checks:

```bash
ssh root@176.57.184.98 "curl -s http://127.0.0.1:3001/api/saas/admin/summary -H 'Authorization: Bearer <ADMIN_PASSWORD>' | head -c 800"
ssh root@176.57.184.98 "journalctl -u battletoads-backend.service -n 120 --no-pager"
```

Browser checks after deploy:
- open `http://176.57.184.98/`
- login with the existing dashboard password
- open `/saas`
- in `Admin`: click `Инициализировать demo tenants`, then `Опубликовать admin TS`
- in `Клиент стратегий`: select `client-bot-01`, assign API key if needed, save, preview, then `Materialize на API key`
- in `Алгофонд`: select `algofund-01`, set API key/risk, save, preview, then send `Запросить старт`
