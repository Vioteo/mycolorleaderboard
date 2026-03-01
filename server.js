const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// Лимиты для защиты от поддельных рекордов (подстрой под свою игру)
const MAX_WAVE = 9999;
const MAX_BOSS_HP = 999999;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;   // 1 минута
const RATE_LIMIT_MAX_POSTS = 15;           // макс. POST с одного IP за окно

const postCountByIp = new Map(); // ip -> { count, firstAt }

function cleanupRateLimit() {
  const now = Date.now();
  for (const [ip, data] of postCountByIp.entries()) {
    if (now - data.firstAt > RATE_LIMIT_WINDOW_MS) postCountByIp.delete(ip);
  }
}

// Логирование запросов
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} | ${req.method} ${req.url}`);
  next();
});

// CORS для запросов из игры
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// GET /api/health — пробуждение сервера (Render и др.), без обращения к БД
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS leaderboard (
        id SERIAL PRIMARY KEY,
        player_name VARCHAR(64) NOT NULL DEFAULT 'Player',
        dungeon_tier INT NOT NULL DEFAULT 0,
        wave INT NOT NULL,
        boss_hp_left INT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    // Миграция: добавить dungeon_tier если колонки нет; старые записи = данж 0
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='leaderboard' AND column_name='dungeon_tier') THEN
          ALTER TABLE leaderboard ADD COLUMN dungeon_tier INT NOT NULL DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='leaderboard' AND column_name='team_hero_ids') THEN
          ALTER TABLE leaderboard ADD COLUMN team_hero_ids VARCHAR(32) DEFAULT NULL;
        END IF;
      END $$;
    `);
    await client.query(`DROP INDEX IF EXISTS idx_leaderboard_rank`);
    await client.query(`
      CREATE INDEX idx_leaderboard_rank
      ON leaderboard (dungeon_tier DESC, wave DESC, boss_hp_left ASC, created_at ASC);
    `);

    // Таблица лидерборда прокачанных героев (один игрок = одна запись)
    await client.query(`
      CREATE TABLE IF NOT EXISTS leaderboard_hero (
        player_name VARCHAR(64) PRIMARY KEY,
        hero_id INT NOT NULL,
        hero_level INT NOT NULL,
        rarest_artifact_def_id INT NOT NULL DEFAULT -1,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_leaderboard_hero_level ON leaderboard_hero (hero_level DESC);
    `);

    // Таблица облачных сохранений (один игрок = одна запись, данные в JSON)
    await client.query(`
      CREATE TABLE IF NOT EXISTS game_saves (
        player_name VARCHAR(64) PRIMARY KEY,
        data JSONB NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
  } finally {
    client.release();
  }
}

// POST — добавить результат (с лимитом по IP и проверкой диапазонов)
app.post('/api/leaderboard', async (req, res) => {
  try {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    cleanupRateLimit();
    const rec = postCountByIp.get(ip);
    const now = Date.now();
    if (rec) {
      if (now - rec.firstAt > RATE_LIMIT_WINDOW_MS) {
        postCountByIp.set(ip, { count: 1, firstAt: now });
      } else if (rec.count >= RATE_LIMIT_MAX_POSTS) {
        console.log(`Rate limit: ${ip} exceeded ${RATE_LIMIT_MAX_POSTS} POSTs`);
        return res.status(429).json({ error: 'Too many submissions, try later' });
      } else {
        rec.count++;
      }
    } else {
      postCountByIp.set(ip, { count: 1, firstAt: now });
    }

    const { player_name = 'Player', dungeon_tier = 0, wave, boss_hp_left, team_hero_ids } = req.body;
    if (wave == null || boss_hp_left == null) {
      return res.status(400).json({ error: 'wave and boss_hp_left required' });
    }
    const dt = Number(dungeon_tier);
    const w = Number(wave);
    const hp = Number(boss_hp_left);
    if (!Number.isInteger(dt) || dt < 0 || dt > 10) {
      return res.status(400).json({ error: 'dungeon_tier must be 0..10' });
    }
    if (!Number.isInteger(w) || w < 1 || w > MAX_WAVE) {
      return res.status(400).json({ error: 'wave must be 1..' + MAX_WAVE });
    }
    if (!Number.isInteger(hp) || hp < 0 || hp > MAX_BOSS_HP) {
      return res.status(400).json({ error: 'boss_hp_left out of range' });
    }
    let teamStr = null;
    if (Array.isArray(team_hero_ids)) {
      teamStr = team_hero_ids.slice(0, 5).map(x => Math.max(-1, Number(x) | 0)).join(',');
    } else if (typeof team_hero_ids === 'string') {
      teamStr = team_hero_ids.slice(0, 20);
    }

    const r = await pool.query(
      'INSERT INTO leaderboard (player_name, dungeon_tier, wave, boss_hp_left, team_hero_ids) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [String(player_name).slice(0, 10), dt, w, hp, teamStr]
    );
    res.status(201).json({ id: r.rows[0].id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to save' });
  }
});

// GET — топ N, 1 запись на игрока (лучший результат), с командой; скрываем dev
app.get('/api/leaderboard', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const r = await pool.query(
      `SELECT player_name, dungeon_tier, wave, boss_hp_left, team_hero_ids, created_at FROM (
         SELECT DISTINCT ON (LOWER(TRIM(player_name))) 
           player_name, dungeon_tier, wave, boss_hp_left, team_hero_ids, created_at
         FROM leaderboard
         WHERE LOWER(TRIM(player_name)) != 'dev'
         ORDER BY LOWER(TRIM(player_name)), dungeon_tier DESC, wave DESC, boss_hp_left ASC, created_at ASC
       ) sub
       ORDER BY dungeon_tier DESC, wave DESC, boss_hp_left ASC LIMIT $1`,
      [limit]
    );
    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load' });
  }
});

// POST — добавить/обновить запись в лидерборде героев (upsert, один игрок = одна запись)
app.post('/api/leaderboard-hero', async (req, res) => {
  try {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    cleanupRateLimit();
    const rec = postCountByIp.get(ip);
    const now = Date.now();
    if (rec) {
      if (now - rec.firstAt > RATE_LIMIT_WINDOW_MS) {
        postCountByIp.set(ip, { count: 1, firstAt: now });
      } else if (rec.count >= RATE_LIMIT_MAX_POSTS) {
        return res.status(429).json({ error: 'Too many submissions, try later' });
      } else {
        rec.count++;
      }
    } else {
      postCountByIp.set(ip, { count: 1, firstAt: now });
    }

    const { player_name = 'Player', hero_id = 0, hero_level = 1, rarest_artifact_def_id = -1 } = req.body;
    const pn = String(player_name).slice(0, 10);
    const hid = Math.max(0, Math.min(19, Number(hero_id) | 0));
    const hlvl = Math.max(1, Math.min(80, Number(hero_level) | 0));
    const raid = Math.max(-1, Number(rarest_artifact_def_id) | 0);

    await pool.query(
      `INSERT INTO leaderboard_hero (player_name, hero_id, hero_level, rarest_artifact_def_id, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (player_name) DO UPDATE SET
         hero_id = EXCLUDED.hero_id, hero_level = EXCLUDED.hero_level, 
         rarest_artifact_def_id = EXCLUDED.rarest_artifact_def_id, updated_at = NOW()`,
      [pn, hid, hlvl, raid]
    );
    res.status(201).json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to save' });
  }
});

// GET — топ героев по уровню (скрываем dev)
app.get('/api/leaderboard-hero', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const r = await pool.query(
      `SELECT player_name, hero_id, hero_level, rarest_artifact_def_id, updated_at FROM leaderboard_hero 
       WHERE LOWER(TRIM(player_name)) != 'dev' 
       ORDER BY hero_level DESC, updated_at ASC LIMIT $1`,
      [limit]
    );
    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load' });
  }
});

// GET — получить сохранение по нику (синхронизация с сервером)
app.get('/api/save', async (req, res) => {
  try {
    const player_name = String(req.query.player_name || '').trim();
    if (!player_name) {
      console.log('[Sync] GET /api/save — player_name required');
      return res.status(400).json({ error: 'player_name required' });
    }
    const pn = player_name.slice(0, 64);
    const r = await pool.query(
      'SELECT data, updated_at FROM game_saves WHERE player_name = $1',
      [pn]
    );
    if (r.rows.length === 0) {
      console.log('[Sync] GET /api/save — download requested, no save | player_name=' + pn);
      return res.status(404).json({ error: 'No save' });
    }
    const updated_at = r.rows[0].updated_at;
    const dataKeys = r.rows[0].data && typeof r.rows[0].data === 'object' ? Object.keys(r.rows[0].data) : [];
    console.log('[Sync] GET /api/save — download OK | player_name=' + pn + ' | updated_at=' + updated_at + ' | data_keys=' + dataKeys.join(','));
    res.json({ data: r.rows[0].data, updated_at });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load save' });
  }
});

// POST — сохранить данные (прогресс + настройки в JSON)
const SAVE_RATE_LIMIT_MAX = 30;
app.post('/api/save', async (req, res) => {
  try {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    cleanupRateLimit();
    const rec = postCountByIp.get(ip);
    const now = Date.now();
    if (rec) {
      if (now - rec.firstAt > RATE_LIMIT_WINDOW_MS) {
        postCountByIp.set(ip, { count: 1, firstAt: now });
      } else if (rec.count >= SAVE_RATE_LIMIT_MAX) {
        return res.status(429).json({ error: 'Too many save requests, try later' });
      } else {
        rec.count++;
      }
    } else {
      postCountByIp.set(ip, { count: 1, firstAt: now });
    }

    const { player_name = 'Player', data = {} } = req.body;
    const pn = String(player_name).slice(0, 64);
    const payload = typeof data === 'object' ? data : {};
    const payloadKeys = Object.keys(payload);
    const r = await pool.query(
      `INSERT INTO game_saves (player_name, data, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (player_name) DO UPDATE SET data = $2, updated_at = NOW()
       RETURNING updated_at`,
      [pn, JSON.stringify(payload)]
    );
    const updated_at = r.rows[0].updated_at;
    console.log('[Sync] POST /api/save — upload OK | player_name=' + pn + ' | updated_at=' + updated_at + ' | payload_keys=' + payloadKeys.join(','));
    res.status(201).json({ ok: true, updated_at });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to save' });
  }
});

// POST — сброс таблиц лидеров (только если player_name === "dev")
app.post('/api/leaderboard-reset', async (req, res) => {
  try {
    const player_name = String(req.body.player_name || '').trim().toLowerCase();
    if (player_name !== 'dev') {
      return res.status(403).json({ error: 'Only dev can reset leaderboard' });
    }
    await pool.query('TRUNCATE TABLE leaderboard');
    await pool.query('TRUNCATE TABLE leaderboard_hero');
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to reset' });
  }
});

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => console.log('Listening on', PORT));
}).catch(err => {
  console.error('DB init failed', err);
  process.exit(1);
});
