# VPS Deployment (Ubuntu 20.04)

## Important

Copy only commands from code blocks.
Do not paste shell prompts (`user@host:~$`, `root@host:~#`) and do not paste command output back into terminal.
Do not use `<owner>/<repo>` in shell commands. Use real values without `<` and `>`.

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

## Update from Git later

```bash
sudo APP_DIR=/opt/battletoads-double-dragon BRANCH=main bash /opt/battletoads-double-dragon/scripts/update_vps_from_git.sh
```

## Alternative: one-command deploy from local machine

```bash
cd /home/yakovbyakov/BattleToads_DoubleDragon/battletoads-double-dragon
ADMIN_PASSWORD='strong-password' bash scripts/deploy_vps_from_local.sh root@176.57.184.98 https://github.com/aleksey-34/battletoads-double-dragon.git 176.57.184.98 main /opt/battletoads-double-dragon
```

Optional SSH key/port:

```bash
SSH_OPTS='-i ~/.ssh/id_rsa -p 22' ADMIN_PASSWORD='strong-password' bash scripts/deploy_vps_from_local.sh root@176.57.184.98 https://github.com/aleksey-34/battletoads-double-dragon.git 176.57.184.98 main /opt/battletoads-double-dragon
```
