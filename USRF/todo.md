Могу сразу сделать безопасный DTO для /api/api-keys (без secret) и совместимую логику редактирования ключа.
Могу затем перевести auth с localStorage password на сессионный токен (httpOnly cookie/JWT session).

Готов сразу переходить. Предлагаю делать так:


***2 и вообще я думаю нужно задумать еще и модуль бектестинга, с отрисовками метрик.
прям на базе стратегий и грубо говоря на том же движке, можно прогонять работу в обратном направлении, просто создать отдельную вкладку в верхнем меню, и взять стратегию с такого то апи ключа и такую то, и протестировать ее на том то и так то и с такой то глубиной, детализацей, комиссией, фандингом.
просто в тестере нужно создать загрузчик базы требуемых свечей и как бы подмену апи биржи - локально созданным своим апи тестера
как тебе идея?




Ядро бектестера в backend (replay OHLC + сделки + equity curve + DD + комиссии/slippage).
API-эндпоинты прогона и сохранения результатов.
UI-страница backtest с графиком equity и таблицей сделок.

tar -xzf btdd_vps_git_bundle_20260308_170954.tar.gz
cd btdd_vps_git_bundle_20260308_170954

sudo DOMAIN=your.domain.com ADMIN_PASSWORD='strong-password' \
bash setup_vps_ubuntu20.sh https://github.com/<owner>/<repo>.git /opt/battletoads-double-dragon main

sudo systemctl status battletoads-backend
sudo systemctl status nginx

sudo APP_DIR=/opt/battletoads-double-dragon BRANCH=main bash update_vps_from_git.sh

curl -sS http://127.0.0.1:3001/api/logs -H 'Authorization: Bearer <your-password>'