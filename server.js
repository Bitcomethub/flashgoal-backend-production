require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 8080;

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
        odds DECIMAL(5,2),
        confidence VARCHAR(50),
        status VARCHAR(50) DEFAULT 'pending',
        result VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Predictions table ready');
    
  } catch (error) {
    console.error('❌ Database error:', error);
  }
}

initDatabase();

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
// PREDICTIONS API
// ============================================

// GET all predictions
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

// GET active predictions only
app.get('/api/predictions/active', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM predictions WHERE status = 'pending' ORDER BY created_at DESC"
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

// GET prediction by ID
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

// POST create new prediction
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

// Update prediction result
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
      'UPDATE predictions SET result = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
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


// Update prediction result
    // Validation
    if (!match_id || !home_team || !away_team || !prediction_type) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    const result = await pool.query(
      `INSERT INTO predictions 
       (match_id, home_team, away_team, league, prediction_type, odds, confidence, status) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending') 
       RETURNING *`,
      [match_id, home_team, away_team, league, prediction_type, odds, confidence]
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

// PUT update prediction
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

// DELETE prediction
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

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'FlashGoal API',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      liveMatches: '/api/matches/live',
      predictions: '/api/predictions',
      activePredictions: '/api/predictions/active',
      createPrediction: 'POST /api/predictions',
      updatePrediction: 'PUT /api/predictions/:id',
      deletePrediction: 'DELETE /api/predictions/:id'
    }
  });
});


// ============================================

// ============================================
// AUTOMATIC PREDICTION RESULT CHECKER (30s)
// ============================================
const cron = require("node-cron");

cron.schedule("*/30 * * * * *", async () => {
  try {
    console.log("🔄 Checking predictions...");
    const { rows: activePredictions } = await pool.query("SELECT * FROM predictions WHERE result IS NULL");
    for (const prediction of activePredictions) {
      try {
        const response = await axios.get(`https://v3.football.api-sports.io/fixtures?id=${prediction.match_id}`, {
          headers: { "x-apisports-key": process.env.FOOTBALL_API_KEY }
        });
        const fixture = response.data.response[0];
        if (!fixture) continue;
        const status = fixture.fixture.status.short;
        const predType = prediction.prediction_type.toUpperCase();
        const isFinished = ["FT", "AET", "PEN"].includes(status);
        const isHalfTimeOrLater = ["HT", "2H", "FT", "AET", "PEN"].includes(status);
        const shouldCheck = predType.includes("İY") || predType.includes("IY") ? isHalfTimeOrLater : isFinished;
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
          } else if (predType.includes("MB")) {
            if (predType.includes("0.5Ü") || predType.includes("0.5U")) result = totalGoals > 0.5 ? "won" : "lost";
            else if (predType.includes("1.5Ü") || predType.includes("1.5U")) result = totalGoals > 1.5 ? "won" : "lost";
            else if (predType.includes("2.5Ü") || predType.includes("2.5U")) result = totalGoals > 2.5 ? "won" : "lost";
            else if (predType.includes("3.5Ü") || predType.includes("3.5U")) result = totalGoals > 3.5 ? "won" : "lost";
            else if (predType.includes("KGV")) result = homeGoals > 0 && awayGoals > 0 ? "won" : "lost";
          }
          if (result) {
            await pool.query("UPDATE predictions SET result = $1, updated_at = NOW() WHERE id = $2", [result, prediction.id]);
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
  console.log(`🚀 FlashGoal API running on port ${PORT}`);
});
