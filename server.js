require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const axios = require('axios');
const cron = require("node-cron");

const app = express();
const PORT = process.env.PORT || 8080;

// Telegram Bot Token
const TELEGRAM_BOT_TOKEN = '8424896876:AAE7CmmCyLfQkpz31pXVmNyTnb_0hWP_Veg';

// Middleware
app.use(cors());
app.use(express.json());

// PostgreSQL Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test database connection and create tables
async function initDatabase() {
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ Database connected successfully');
    
    // Create predictions table
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
    
    // Create pending predictions table
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

// ============================================
// TELEGRAM WEBHOOK SYSTEM
// ============================================

function parseTelegramMessage(text) {
  try {
    const lines = text.split('\n');
    
    const buttonMatch = text.match(/The Button (\w+) has matched/);
    const button = buttonMatch ? buttonMatch[1] : null;
    
    const matchLine = lines.find(line => line.includes('V'));
    let homeTeam = '';
    let awayTeam = '';
    if (matchLine) {
      const teams = matchLine.split('V');
      homeTeam = teams[0].replace(/\(\d+\)/g, '').trim();
      awayTeam = teams[1].replace(/\(\d+\)/g, '').trim();
    }
    
    const leagueLine = lines.find(line => line.includes(':-'));
    const league = leagueLine ? leagueLine.split(':-')[1].trim() : 'Unknown';
    
    const timeMatch = text.match(/Elapsed Time: (\d+)'/);
    const elapsed = timeMatch ? parseInt(timeMatch[1]) : 0;
    
    const scoreMatch = text.match(/Score: (\d+)\s*-\s*(\d+)/);
    const homeScore = scoreMatch ? parseInt(scoreMatch[1]) : 0;
    const awayScore = scoreMatch ? parseInt(scoreMatch[2]) : 0;
    
    const buttonConfig = {
      'FHGfinder': { prediction: 'İlk yarı 1 gol', urgent: false },
      'LastMinGoal': { prediction: 'Son dakika 1 gol', urgent: true },
      'LayDraw75': { prediction: '75+ 1 gol', urgent: false },
      'BTTSactive': { prediction: 'KGV veya 1 gol', urgent: false },
      'MikeFH1goal': { prediction: 'İlk yarı ilk gol', urgent: false },
      'GoalStorm': { prediction: '1 gol daha', urgent: false },
      'MidO15': { prediction: '1.5Ü', urgent: true },
      'FHFlow': { prediction: 'İlk yarı devam 1 gol', urgent: true },
    };
    
    const config = buttonConfig[button] || { prediction: '1 gol', urgent: false };
    
    return {
      button,
      homeTeam,
      awayTeam,
      league,
      elapsed,
      homeScore,
      awayScore,
      predictionText: config.prediction,
      urgent: config.urgent,
    };
  } catch (error) {
    console.error('Parse error:', error);
    return null;
  }
}

app.post('/api/telegram/webhook', async (req, res) => {
  try {
    const message = req.body?.message?.text;
    
    if (!message || !message.includes('The Button')) {
      return res.sendStatus(200);
    }
    
    console.log('📨 Telegram webhook received');
    
    const parsed = parseTelegramMessage(message);
    
    if (!parsed || !parsed.homeTeam || !parsed.awayTeam) {
      console.error('❌ Parse failed');
      return res.sendStatus(400);
    }
    
    await pool.query(
      `INSERT INTO pending_predictions 
       (button_name, home_team, away_team, league, current_minute, 
        home_score, away_score, prediction_text, is_urgent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        parsed.button,
        parsed.homeTeam,
        parsed.awayTeam,
        parsed.league,
        parsed.elapsed,
        parsed.homeScore,
        parsed.awayScore,
        parsed.predictionText,
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
        match_id,
        pred.home_team,
        pred.away_team,
        pred.league,
        prediction_type,
        team_type,
        odds,
        confidence,
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


// ============================================
// LIVE MATCHES API
// ============================================

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
    
    res.json({
      success: true,
      count: matches.length,
      matches: matches
    });
  } catch (error) {
    console.error('Live matches error:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch live matches' 
    });
  }
});

// ============================================
// ODDS API
// ============================================

app.get('/api/odds/:match_id', async (req, res) => {
  try {
    const { match_id } = req.params;
    
    const response = await axios.get('https://v3.football.api-sports.io/odds/live', {
      params: { fixture: match_id },
      headers: {
        'x-apisports-key': process.env.FOOTBALL_API_KEY,
        'x-rapidapi-host': 'v3.football.api-sports.io'
      }
    });

    const data = response.data.response[0];
    
    if (!data || !data.bookmakers || data.bookmakers.length === 0) {
      return res.json({
        success: true,
        odds: null,
        message: 'No odds available for this match'
      });
    }

    const bookmaker = data.bookmakers[0];
    const overUnder = bookmaker.bets.find(bet => bet.name === 'Goals Over/Under');
    
    const parsedOdds = {
      bookmaker: bookmaker.name,
      overUnder: overUnder ? overUnder.values.map(v => ({
        value: v.value,
        over: parseFloat(v.odd),
        under: v.under ? parseFloat(v.under) : null
      })) : []
    };

    res.json({
      success: true,
      odds: parsedOdds
    });
  } catch (error) {
    console.error('Get odds error:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch odds' 
    });
  }
});

// ============================================
// PREDICTIONS API
// ============================================

app.get('/api/predictions', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM predictions ORDER BY created_at DESC'
    );
    
    res.json({
      success: true,
      count: result.rows.length,
      predictions: result.rows
    });
  } catch (error) {
    console.error('Get predictions error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch predictions' 
    });
  }
});

app.get('/api/predictions/active', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM predictions WHERE status = 'active' ORDER BY created_at DESC"
    );
    
    res.json({
      success: true,
      count: result.rows.length,
      predictions: result.rows
    });
  } catch (error) {
    console.error('Get active predictions error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch active predictions' 
    });
  }
});

app.get('/api/predictions/past', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM predictions WHERE status IN ('won', 'lost') ORDER BY updated_at DESC"
    );
    
    res.json({
      success: true,
      count: result.rows.length,
      predictions: result.rows
    });
  } catch (error) {
    console.error('Get past predictions error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch past predictions' 
    });
  }
});

app.get('/api/predictions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT * FROM predictions WHERE id = $1',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Prediction not found' 
      });
    }
    
    res.json({
      success: true,
      prediction: result.rows[0]
    });
  } catch (error) {
    console.error('Get prediction error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch prediction' 
    });
  }
});

app.post('/api/predictions', async (req, res) => {
  try {
    const {
      match_id,
      home_team,
      away_team,
      league,
      prediction_type,
      odds,
      confidence
    } = req.body;

    if (!match_id || !home_team || !away_team || !prediction_type) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    const result = await pool.query(
      `INSERT INTO predictions 
       (match_id, home_team, away_team, league, prediction_type, odds, confidence, status) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active') 
       RETURNING *`,
      [match_id, home_team, away_team, league, prediction_type, odds || 0, confidence || 'medium']
    );

    res.status(201).json({
      success: true,
      message: 'Prediction created successfully',
      prediction: result.rows[0]
    });
  } catch (error) {
    console.error('Create prediction error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to create prediction' 
    });
  }
});

app.put('/api/predictions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, result: predictionResult } = req.body;

    const updateResult = await pool.query(
      `UPDATE predictions 
       SET status = $1, result = $2, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $3 
       RETURNING *`,
      [status, predictionResult, id]
    );

    if (updateResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Prediction not found' 
      });
    }

    res.json({
      success: true,
      message: 'Prediction updated successfully',
      prediction: updateResult.rows[0]
    });
  } catch (error) {
    console.error('Update prediction error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to update prediction' 
    });
  }
});

app.put('/api/predictions/:id/result', async (req, res) => {
  try {
    const { id } = req.params;
    const { result } = req.body;

    if (!result || !['won', 'lost'].includes(result)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Result must be "won" or "lost"' 
      });
    }

    const updateResult = await pool.query(
      'UPDATE predictions SET status = $1, result = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [result, id]
    );

    if (updateResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Prediction not found' 
      });
    }

    res.json({
      success: true,
      message: `Prediction marked as ${result}`,
      prediction: updateResult.rows[0]
    });
  } catch (error) {
    console.error('Update result error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to update prediction result' 
    });
  }
});

app.delete('/api/predictions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(
      'DELETE FROM predictions WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Prediction not found' 
      });
    }

    res.json({
      success: true,
      message: 'Prediction deleted successfully'
    });
  } catch (error) {
    console.error('Delete prediction error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to delete prediction' 
    });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({
    name: 'FlashGoal API',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      liveMatches: '/api/matches/live',
      predictions: '/api/predictions',
      activePredictions: '/api/predictions/active',
      pastPredictions: '/api/predictions/past',
      pendingPredictions: '/api/predictions/pending',
      telegramWebhook: 'POST /api/telegram/webhook',
      createPrediction: 'POST /api/predictions',
      updatePrediction: 'PUT /api/predictions/:id',
      deletePrediction: 'DELETE /api/predictions/:id'
    }
  });
});


// ============================================
// CRON JOBS
// ============================================

cron.schedule("*/30 * * * * *", async () => {
  try {
    const { rows: activePredictions } = await pool.query(
      "SELECT * FROM predictions WHERE status = 'active'"
    );
    
    for (const prediction of activePredictions) {
      try {
        const response = await axios.get(
          `https://v3.football.api-sports.io/fixtures?id=${prediction.match_id}`, 
          {
            headers: { "x-apisports-key": process.env.FOOTBALL_API_KEY }
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
            if (predType.includes("0.5Ü") || predType.includes("0.5U")) {
              result = htTotal > 0.5 ? "won" : "lost";
            } else if (predType.includes("1.5Ü") || predType.includes("1.5U")) {
              result = htTotal > 1.5 ? "won" : "lost";
            } else if (predType.includes("2.5Ü") || predType.includes("2.5U")) {
              result = htTotal > 2.5 ? "won" : "lost";
            }
          } 
          else if (predType.includes("MB")) {
            if (predType.includes("0.5Ü") || predType.includes("0.5U")) {
              result = totalGoals > 0.5 ? "won" : "lost";
            } else if (predType.includes("1.5Ü") || predType.includes("1.5U")) {
              result = totalGoals > 1.5 ? "won" : "lost";
            } else if (predType.includes("2.5Ü") || predType.includes("2.5U")) {
              result = totalGoals > 2.5 ? "won" : "lost";
            } else if (predType.includes("3.5Ü") || predType.includes("3.5U")) {
              result = totalGoals > 3.5 ? "won" : "lost";
            } else if (predType.includes("4.5Ü") || predType.includes("4.5U")) {
              result = totalGoals > 4.5 ? "won" : "lost";
            } else if (predType.includes("KGV")) {
              result = homeGoals > 0 && awayGoals > 0 ? "won" : "lost";
            }
          }
          
          if (result) {
            await pool.query(
              "UPDATE predictions SET status = $1, result = $1, updated_at = NOW() WHERE id = $2", 
              [result, prediction.id]
            );
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

cron.schedule("0 0 * * *", async () => {
  try {
    console.log("🗑️ Resetting past predictions...");
    
    const result = await pool.query(
      "DELETE FROM predictions WHERE status IN ('won', 'lost') AND updated_at < NOW() - INTERVAL '1 day'"
    );
    
    console.log(`✅ Deleted ${result.rowCount} old predictions`);
  } catch (error) {
    console.error("Reset predictions error:", error.message);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 FlashGoal API running on port ${PORT}`);
});
