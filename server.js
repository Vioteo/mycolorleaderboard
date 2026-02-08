const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

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
        wave INT NOT NULL,
        boss_hp_left INT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_leaderboard_rank
      ON leaderboard (wave DESC, boss_hp_left ASC);
    `);
  } finally {
    client.release();
  }
}

// POST — добавить результат
app.post('/api/leaderboard', async (req, res) => {
  try {
    const { player_name = 'Player', wave, boss_hp_left } = req.body;
    if (wave == null || boss_hp_left == null) {
      return res.status(400).json({ error: 'wave and boss_hp_left required' });
    }
    const r = await pool.query(
      'INSERT INTO leaderboard (player_name, wave, boss_hp_left) VALUES ($1, $2, $3) RETURNING id',
      [String(player_name).slice(0, 64), Number(wave), Number(boss_hp_left)]
    );
    res.status(201).json({ id: r.rows[0].id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to save' });
  }
});

// GET — топ N (сортировка: выше волна, меньше HP босса)
app.get('/api/leaderboard', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const r = await pool.query(
      'SELECT player_name, wave, boss_hp_left, created_at FROM leaderboard ORDER BY wave DESC, boss_hp_left ASC LIMIT $1',
      [limit]
    );
    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load' });
  }
});

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => console.log('Listening on', PORT));
}).catch(err => {
  console.error('DB init failed', err);
  process.exit(1);
});
