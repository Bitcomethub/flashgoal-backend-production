require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const axios = require('axios');
const cron = require("node-cron");

const app = express();
const PORT = process.env.PORT || 8080;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8456101536:AAFZsluytLNaYPl4HxLctCvKLkLYk962r_A';

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
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pending_predictions (
        id SERIAL PRIMARY KEY,
        button_name VARCHAR(50),
        home_team VARCHAR(100) NOT NULL,
        away_team VARCHAR(100) NOT NULL,
        league VARCHAR(100),
        current_minute INT,
        home_score INT DEFAULT 0,
        away_score INT DEFAULT 0,
        prediction_text VARCHAR(200),
        suggested_odds DECIMAL(5,2),
        is_urgent BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Pending predictions table ready');
    
  } catch (error) {
    console.error('❌ Database error:', error);
  }
}

initDatabase();

const BUTTON_CONFIG = {
  'FHGfinder': { base: 'İY', addGoals: 1, urgent: false },
  'LastMinGoal': { base: 'MB', addGoals: 1, urgent: true },
  'LayDraw75': { base: 'MB', addGoals: 1, urgent: false },
  'BTTSactive': { base: 'KGV', addGoals: 0, urgent: false },
  'MikeFH1goal': { base: 'İY', addGoals: 1, urgent: false },
  'GoalStorm': { base: 'MB', addGoals: 1, urgent: false },
  'MidO15': { base: 'MB', addGoals: 2, urgent: true },
  'FHFlow': { base: 'İY', addGoals: 1, urgent: true },
};

function calculateOdds(totalGoals, addGoals) {
  const target = totalGoals + addGoals;
  if (target <= 0.5) return 1.50;
  if (target <= 1.5) return 1.75;
  if (target <= 2.5) return 2.00;
  if (target <= 3.5) return 2.25;
  if (target <= 4.5) return 2.50;
  return 3.00;
}

function parseTelegramMessage(text) {
  try {
    const buttonMatch = text.match(/The Button (\w+) has matched/);
    const button = buttonMatch ? buttonMatch[1] : null;
    
    const lines = text.split('\n');
    const matchLine = lines.find(line => line.includes('V') || line.includes('vs'));
    let homeTeam = '';
    let awayTeam = '';
    
    if (matchLine) {
      const cleanLine = matchLine.replace(/\(\d+\)/g, '').trim();
      const teams = cleanLine.split(/\s+V\s+|\s+vs\s+/i);
      if (teams.length >= 2) {
        homeTeam = teams[0].trim();
        awayTeam = teams[1].trim();
      }
    }
    
    const leagueLine = lines.find(line => line.includes(':-') || line.includes('League'));
    let league = 'Unknown';
    if (leagueLine) {
      const leagueMatch = leagueLine.match(/:-\s*(.+)|League\s*:\s*(.+)/i);
      league = leagueMatch ? (leagueMatch[1] || leagueMatch[2]).trim() : 'Unknown';
    }
    
    const timeMatch = text.match(/Elapsed Time:\s*(\d+)/i);
    const elapsed = timeMatch ? parseInt(timeMatch[1]) : 0;
    
    const scoreMatch = text.match(/Score:\s*(\d+)\s*-\s*(\d+)/i);
    const homeScore = scoreMatch ? parseInt(scoreMatch[1]) : 0;
    const awayScore = scoreMatch ? parseInt(scoreMatch[2]) : 0;
    const totalGoals = homeScore + awayScore;
    
    const config = BUTTON_CONFIG[button] || { base: 'MB', addGoals: 1, urgent: false };
    
    let predictionText = '';
    if (config.base === 'KGV') {
      predictionText = 'KGV';
    } else {
      const targetGoals = totalGoals + config.addGoals;
      predictionText = `${config.base} ${targetGoals - 0.5}Ü`;
    }
    
    const suggestedOdds = config.base === 'KGV' ? 1.85 : calculateOdds(totalGoals, config.addGoals);
    
    return {
      button,
      homeTeam,
      awayTeam,
      league,
      elapsed,
      homeScore,
      awayScore,
      predictionText,
      suggestedOdds,
      urgent: config.urgent,
    };
  } catch (error) {
    console.error('Parse error:', error);
    return null;
  }
}

app.post('/api/telegram/webhook', async (req, res) => {
  try {
    const message = req.body?.message?.text || req.body?.message?.forward_from?.text;
    
    if (!message || !message.includes('The Button')) {
      return res.sendStatus(200);
    }
    
    console.log('📨 Telegram message received');
    
    const parsed = parseTelegramMessage(message);
    
    if (!parsed || !parsed.homeTeam || !parsed.awayTeam) {
      console.error('❌ Parse failed');
      return res.sendStatus(400);
    }
    
    await pool.query(
      `INSERT INTO pending_predictions 
       (button_name, home_team, away_team, league, current_minute, 
        home_score, away_score, prediction_text, suggested_odds, is_urgent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        parsed.button,
        parsed.homeTeam,
        parsed.awayTeam,
        parsed.league,
        parsed.elapsed,
        parsed.homeScore,
        parsed.awayScore,
        parsed.predictionText,
        parsed.suggestedOdds,
        parsed.urgent,
      ]
    );
    
    console.log('✅ Pending prediction added:', parsed.homeTeam, 'vs', parsed.awayTeam);
    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/predictions/pending', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM pending_predictions ORDER BY created_at DESC'
    );
    res.json({ success: true, predictions: result.rows });
  } catch (error) {
    console.error('Error fetching pending:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/predictions/pending/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const { match_id, prediction_type, team_type, odds, confidence } = req.body;
    
    if (!prediction_type || !odds) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    
    const pending = await pool.query(
      'SELECT * FROM pending_predictions WHERE id = $1',
      [id]
    );
    
    if (pending.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }
    
    const pred = pending.rows[0];
    
    await pool.query(
      `INSERT INTO predictions 
       (match_id, home_team, away_team, league, prediction_type, 
        team_type, odds, confidence, current_minute, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active')`,
      [
        match_id || Math.floor(Math.random() * 1000000),
        pred.home_team,
        pred.away_team,
        pred.league,
        prediction_type,
        team_type || 'total',
        odds,
        confidence || 'orta',
        pred.current_minute,
      ]
    );
    
    await pool.query('DELETE FROM pending_predictions WHERE id = $1', [id]);
    
    console.log('✅ Prediction approved:', pred.home_team, 'vs', pred.away_team);
    res.json({ success: true });
  } catch (error) {
    console.error('Error approving:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/predictions/pending/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM pending_predictions WHERE id = $1', [id]);
    console.log('❌ Prediction rejected:', id);
    res.json({ success: true });
  } catch (error) {
    console.error('Error rejecting:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

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
    console.error('Live matches error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch live matches' });
  }
});

app.get('/api/predictions', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM predictions ORDER BY created_at DESC');
    res.json({ success: true, count: result.rows.length, predictions: result.rows });
  } catch (error) {
    console.error('Get predictions error:', error);
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
    console.error('Create prediction error:', error);
    res.status(500).json({ success: false, error: 'Failed to create prediction' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({
    name: 'FlashGoal API',
    version: '2.0.0',
    endpoints: {
      health: '/health',
      liveMatches: '/api/matches/live',
      predictions: '/api/predictions',
      pendingPredictions: '/api/predictions/pending',
      telegramWebhook: 'POST /api/telegram/webhook',
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
          { headers: { "x-apisports-key": process.env.FOOTBALL_API_KEY } }
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
        console.error(`Error checking prediction #${prediction.id}:`, err.message);
      }
    }
  } catch (error) {
    console.error("Cron job error:", error.message);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 FlashGoal API v2.0 running on port ${PORT}`);
});
