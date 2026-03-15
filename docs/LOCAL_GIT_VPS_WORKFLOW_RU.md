# Локальная работа с Git и обновление VPS

Этот файл описывает базовый рабочий цикл для проекта: как коммитить локально, пушить в GitHub и обновлять сервер с локальной машины.

## 1. Базовая схема

Обычный цикл такой:

1. Внести изменения локально.
2. Проверить `git status`.
3. Сделать `git add`.
4. Сделать `git commit`.
5. Отправить ветку через `git push`.
6. С локальной машины запустить обновление VPS через `deploy.sh`.

Важно:

- Не используйте `source deploy.sh ...`.
- Запускайте `deploy.sh` только как команду через `bash`.
- Если деплой выполняется по Git-ветке, на VPS должны быть доступны нужные коммиты в origin.

## 2. Локальный Git workflow

Перейти в проект:

```bash
cd /home/yakovbyakov/BattleToads_DoubleDragon/battletoads-double-dragon
```

Посмотреть изменения:

```bash
git status --short
```

Посмотреть, что именно изменилось:

```bash
git diff
```

Добавить конкретные файлы:

```bash
git add frontend/src/pages/SaaS.tsx frontend/src/components/ChartComponent.tsx
```

Или добавить все изменения:

```bash
git add .
```

Сделать коммит:

```bash
git commit -m "fix: краткое описание изменения"
```

Отправить текущую ветку в origin:

```bash
git push origin feature/tv-engine-refactor
```

Проверить, что локальная ветка чистая:

```bash
git status
```

## 3. Быстрые команды на каждый день

Если изменения уже готовы:

```bash
git status --short
git add .
git commit -m "feat: описание"
git push origin feature/tv-engine-refactor
```

Если нужно просто подтянуть удаленную ветку локально:

```bash
git pull --ff-only origin feature/tv-engine-refactor
```

## 4. Обновление VPS с локальной машины

Основной безопасный способ:

```bash
bash ./deploy.sh local root@176.57.184.98 feature/tv-engine-refactor /opt/battletoads-double-dragon
```

В этом репозитории для git-based деплоя с локальной машины используется режим `local`. Общая схема такая:

1. локально запушить ветку;
2. затем с локальной машины вызвать deploy-скрипт;
3. на VPS выполнить pull/build/restart.

Если запуск идет прямо на VPS, используйте:

```bash
sudo bash /opt/battletoads-double-dragon/deploy.sh vps feature/tv-engine-refactor /opt/battletoads-double-dragon
```

## 5. Если терминал VPS “вылетает”

Чаще всего причина в том, что скрипт запускают через `source`.

Неправильно:

```bash
source ./deploy.sh vps feature/tv-engine-refactor /opt/battletoads-double-dragon
```

Правильно:

```bash
bash ./deploy.sh vps feature/tv-engine-refactor /opt/battletoads-double-dragon
```

Или на VPS:

```bash
sudo bash /opt/battletoads-double-dragon/deploy.sh vps feature/tv-engine-refactor /opt/battletoads-double-dragon
```

## 6. Деплой в фоне с логом

Если не хотите держать открытую сессию:

```bash
sudo nohup bash /opt/battletoads-double-dragon/deploy.sh vps feature/tv-engine-refactor /opt/battletoads-double-dragon > /root/btdd_deploy.log 2>&1 < /dev/null &
```

Смотреть лог:

```bash
tail -f /root/btdd_deploy.log
```

## 7. Проверка после обновления

Проверить, что на VPS подтянулся нужный коммит:

```bash
git -C /opt/battletoads-double-dragon log --oneline -n 5
```

Проверить backend:

```bash
sudo systemctl status battletoads-backend.service --no-pager | head -n 30
```

Проверить nginx:

```bash
sudo systemctl status nginx --no-pager | head -n 20
```

## 8. Когда использовать deploy по Git, а когда по текущему дереву

По Git-ветке:

- использовать, когда изменения уже закоммичены и запушены;
- это основной и самый чистый вариант.

По текущему локальному дереву:

- использовать только если нужно отправить на VPS незакоммиченные локальные изменения;
- это удобно для срочной проверки, но хуже для повторяемости.

Если есть выбор, предпочитайте деплой по Git-ветке.

## 9. Минимальный рекомендуемый сценарий

```bash
cd /home/yakovbyakov/BattleToads_DoubleDragon/battletoads-double-dragon
git status --short
git add .
git commit -m "fix: описание"
git push origin feature/tv-engine-refactor
bash ./deploy.sh local root@176.57.184.98 feature/tv-engine-refactor /opt/battletoads-double-dragon
```

## 10. Что делать, если деплой не прошел

1. Проверить, что ветка действительно запушилась: `git log --oneline -n 5` и `git status`.
2. Проверить, что на VPS нет локальных незакоммиченных изменений.
3. Проверить `systemctl status battletoads-backend.service`.
4. Проверить лог деплоя или backend-лог.
5. Если ошибка на `npm install` или `npm run build`, сначала чинить ее локально, затем повторить push + deploy.