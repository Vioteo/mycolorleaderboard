# Leaderboard API (Render + PostgreSQL)

1. На Render создай **Web Service**, подключи репозиторий, укажи **Root Directory**: `server`.
2. **Build Command**: `npm install`
3. **Start Command**: `npm start`
4. В **Environment** добавь переменную `DATABASE_URL` со значением **Internal Database URL** из твоей Render PostgreSQL.
5. После деплоя скопируй URL сервиса (например `https://colors-leaderboard.onrender.com`) и в проекте GameMaker в `scripts/game_constants/game_constants.gml` замени `LEADERBOARD_BASE_URL` на этот URL (без слэша в конце).

Локально: создай `server/.env` с `DATABASE_URL=...` (External URL из Render) и запускай `npm start`.
