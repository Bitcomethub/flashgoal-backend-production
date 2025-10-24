require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const axios = require('axios');
const cron = require("node-cron");

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initDatabase() {
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ Database connected successfully');
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS predictions (
        id SERIAL PRIMARY KEY,
        match_id INTEGER NOT NULL,
        home_team VARCHAR(255) NOT NULL,
        away_team VARCHAR(255) NOT NULL,
        league VARCHAR(255),
        prediction_type VARCHAR(100) NOT NULL,
        team_type VARCHAR(50),
        current_minute INT,
        odds DECIMAL(5,2),
        confidence VARCHAR(50),
        status VARCHAR(50) DEFAULT 'active',
        result VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Predictions table ready');
    
    // Drop pending_predictions table
    await pool.query('DROP TABLE IF EXISTS pending_predictions');
    console.log('🗑️ Pending predictions table removed');
    
  } catch (error) {
    console.error('❌ Database error:', error);
  }
}

initDatabase();

app.get('/api/matches/live', async (req, res) => {
  try {
    const response = await axios.get('https://v3.football.api-sports.io/fixtures', {
      params: { live: 'all' },
      headers: {
        'x-apisports-key': process.env.FOOTBALL_API_KEY,
        'x-rapidapi-host': 'v3.football.api-sports.io'
      }
    });

    const matches = response.data.response;
    res.json({ success: true, count: matches.length, matches: matches });
  } catch (error) {
    console.error('❌ Live matches error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch live matches' });
  }
});

app.get('/api/predictions', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM predictions ORDER BY created_at DESC');
    res.json({ success: true, count: result.rows.length, predictions: result.rows });
  } catch (error) {
    console.error('❌ Get predictions error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch predictions' });
  }
});

app.post('/api/predictions', async (req, res) => {
  try {
    const { match_id, home_team, away_team, league, prediction_type, odds, confidence } = req.body;

    if (!match_id || !home_team || !away_team || !prediction_type) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const result = await pool.query(
      `INSERT INTO predictions 
       (match_id, home_team, away_team, league, prediction_type, odds, confidence, status) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active') 
       RETURNING *`,
      [match_id, home_team, away_team, league, prediction_type, odds || 0, confidence || 'orta']
    );

    res.status(201).json({ success: true, prediction: result.rows[0] });
  } catch (error) {
    console.error('❌ Create prediction error:', error);
    res.status(500).json({ success: false, error: 'Failed to create prediction' });
  }
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      database: 'connected'
    });
  } catch (error) {
    res.status(503).json({ 
      status: 'error', 
      timestamp: new Date().toISOString(),
      database: 'disconnected',
      error: error.message
    });
  }
});

app.get('/', (req, res) => {
  res.json({
    name: 'FlashGoal API',
    version: '4.0.0-clean',
    status: 'production-ready',
    endpoints: {
      health: '/health',
      liveMatches: '/api/matches/live',
      predictions: '/api/predictions'
    }
  });
});

cron.schedule("*/30 * * * * *", async () => {
  try {
    const { rows: activePredictions } = await pool.query("SELECT * FROM predictions WHERE status = 'active'");
    
    for (const prediction of activePredictions) {
      try {
        const response = await axios.get(
          `https://v3.football.api-sports.io/fixtures?id=${prediction.match_id}`, 
          { 
            headers: { "x-apisports-key": process.env.FOOTBALL_API_KEY },
            timeout: 5000
          }
        );
        
        const fixture = response.data.response[0];
        if (!fixture) continue;
        
        const status = fixture.fixture.status.short;
        const predType = prediction.prediction_type.toUpperCase();
        
        const isFinished = ["FT", "AET", "PEN"].includes(status);
        const isHalfTimeOrLater = ["HT", "2H", "FT", "AET", "PEN"].includes(status);
        
        const shouldCheck = predType.includes("İY") || predType.includes("IY") 
          ? isHalfTimeOrLater 
          : isFinished;
        
        if (shouldCheck) {
          const homeGoals = fixture.goals.home || 0;
          const awayGoals = fixture.goals.away || 0;
          const totalGoals = homeGoals + awayGoals;
          
          const htScore = fixture.score.halftime;
          const htTotal = (htScore?.home || 0) + (htScore?.away || 0);
          
          let result = null;
          
          if (predType.includes("İY") || predType.includes("IY")) {
            if (predType.includes("0.5Ü") || predType.includes("0.5U")) result = htTotal > 0.5 ? "won" : "lost";
            else if (predType.includes("1.5Ü") || predType.includes("1.5U")) result = htTotal > 1.5 ? "won" : "lost";
            else if (predType.includes("2.5Ü") || predType.includes("2.5U")) result = htTotal > 2.5 ? "won" : "lost";
          } 
          else if (predType.includes("MB")) {
            if (predType.includes("0.5Ü") || predType.includes("0.5U")) result = totalGoals > 0.5 ? "won" : "lost";
            else if (predType.includes("1.5Ü") || predType.includes("1.5U")) result = totalGoals > 1.5 ? "won" : "lost";
            else if (predType.includes("2.5Ü") || predType.includes("2.5U")) result = totalGoals > 2.5 ? "won" : "lost";
            else if (predType.includes("3.5Ü") || predType.includes("3.5U")) result = totalGoals > 3.5 ? "won" : "lost";
            else if (predType.includes("4.5Ü") || predType.includes("4.5U")) result = totalGoals > 4.5 ? "won" : "lost";
            else if (predType.includes("KGV")) result = homeGoals > 0 && awayGoals > 0 ? "won" : "lost";
          }
          
          if (result) {
            await pool.query("UPDATE predictions SET status = $1, result = $1, updated_at = NOW() WHERE id = $2", [result, prediction.id]);
            console.log(`✅ Prediction #${prediction.id} updated: ${result.toUpperCase()}`);
          }
        }
      } catch (err) {
        console.error(`❌ Error checking prediction #${prediction.id}:`, err.message);
      }
    }
  } catch (error) {
    console.error("❌ Cron job error:", error.message);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 FlashGoal API v4.0 CLEAN running on port ${PORT}`);
});
