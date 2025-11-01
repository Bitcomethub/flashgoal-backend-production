require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const axios = require('axios');
const cron = require("node-cron");
const getColors = require('get-image-colors');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// Rate limiting için basit memory store
const rateLimitStore = new Map();

// Rate limiting middleware (batch endpoint için)
const rateLimitBatch = (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const windowMs = 10000; // 10 saniye
  
  const userRequests = rateLimitStore.get(ip) || [];
  const recentRequests = userRequests.filter(time => now - time < windowMs);
  
  if (recentRequests.length >= 1) {
    return res.status(429).json({ 
      error: 'Too many requests. Please wait 10 seconds before making another batch request.' 
    });
  }
  
  recentRequests.push(now);
  rateLimitStore.set(ip, recentRequests);
  
  // Cleanup eski kayıtları (her 5 dakikada bir temizle)
  if (Math.random() < 0.01) { // %1 şansla temizle
    const fiveMinutesAgo = now - 300000;
    for (const [key, requests] of rateLimitStore.entries()) {
      const filtered = requests.filter(time => now - time < fiveMinutesAgo);
      if (filtered.length === 0) {
        rateLimitStore.delete(key);
      } else {
        rateLimitStore.set(key, filtered);
      }
    }
  }
  
  next();
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function getTeamColors(logoUrl) {
  try {
    const colors = await getColors(logoUrl);
    return colors.slice(0, 2).map(c => c.hex());
  } catch (error) {
    console.error('Color extract error:', error);
    return ['#10B981', '#3B82F6']; // Default yeşil-mavi
  }
}

async function initDatabase() {
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ Database connected');
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS predictions (
        id SERIAL PRIMARY KEY,
        match_id VARCHAR(255) NOT NULL,
        home_team VARCHAR(255) NOT NULL,
        away_team VARCHAR(255) NOT NULL,
        league VARCHAR(255),
        prediction_type VARCHAR(100) NOT NULL,
        team_type VARCHAR(50),
        current_minute INT,
        odds DECIMAL(5,2) DEFAULT 0,
        confidence VARCHAR(50),
        status VARCHAR(50) DEFAULT 'active',
        result VARCHAR(50),
        home_logo VARCHAR(500),
        away_logo VARCHAR(500),
        league_flag VARCHAR(100),
        league_logo VARCHAR(500),
        home_score INT DEFAULT 0,
        away_score INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP
      )
    `);
    
    // Add completed_at column if it doesn't exist (for existing tables)
    try {
      await pool.query(`
        ALTER TABLE predictions 
        ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP
      `);
      console.log('✅ completed_at column ready');
    } catch (error) {
      if (!error.message.includes('does not exist')) {
        console.log('ℹ️ completed_at column check:', error.message);
      }
    }
    
    // Update match_id column type if it's INTEGER (for existing tables)
    try {
      await pool.query(`
        ALTER TABLE predictions 
        ALTER COLUMN match_id TYPE VARCHAR(255) USING match_id::VARCHAR(255)
      `);
      console.log('✅ match_id column updated to VARCHAR');
    } catch (error) {
      // Column might already be VARCHAR or table might not exist yet
      if (!error.message.includes('does not exist') && !error.message.includes('type')) {
        console.log('ℹ️ match_id column type update skipped:', error.message);
      }
    }
    
    console.log('✅ Table ready');
    
    // Create vip_access table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vip_access (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) UNIQUE NOT NULL,
        expiry_date TIMESTAMP NOT NULL,
        product_id VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_vip_user ON vip_access(user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_vip_expiry ON vip_access(expiry_date)`);
    console.log('✅ VIP access table ready');
    
    await pool.query('DROP TABLE IF EXISTS pending_predictions CASCADE');
    console.log('🗑️ Cleaned');
    
  } catch (error) {
    console.error('❌ DB error:', error);
  }
}

initDatabase();

// CLEANUP ENDPOINT - Delete old predictions
app.post('/api/cleanup', async (req, res) => {
  try {
    // Delete predictions older than 2 days
    const result = await pool.query(
      `DELETE FROM predictions 
       WHERE created_at < NOW() - INTERVAL '2 days' 
       RETURNING id`
    );
    
    res.json({ 
      success: true, 
      message: `Deleted ${result.rowCount} old predictions`,
      count: result.rowCount 
    });
  } catch (error) {
    console.error('❌ Cleanup error:', error);
    res.status(500).json({ success: false, error: 'Cleanup failed' });
  }
});

// DELETE ALL PREDICTIONS (dangerous - use carefully)
app.delete('/api/predictions/all', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM predictions RETURNING id');
    res.json({ 
      success: true, 
      message: `Deleted all ${result.rowCount} predictions`,
      count: result.rowCount 
    });
  } catch (error) {
    console.error('❌ Delete all error:', error);
    res.status(500).json({ success: false, error: 'Delete failed' });
  }
});

app.get('/api/matches/live', async (req, res) => {
  try {
    const response = await axios.get('https://v3.football.api-sports.io/fixtures', {
      params: { live: 'all' },
      headers: {
        'x-apisports-key': process.env.FOOTBALL_API_KEY,
        'x-rapidapi-host': 'v3.football.api-sports.io'
      },
      timeout: 10000
    });

    const matches = response.data.response;
    res.json({ success: true, count: matches.length, matches: matches });
  } catch (error) {
    console.error('❌ Live matches:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch' });
  }
});

app.get('/api/matches/:id', async (req, res) => {
  const matchId = req.params.id;
  
  try {
    const response = await axios.get(
      `https://v3.football.api-sports.io/fixtures`,
      {
        params: { id: matchId },
        headers: {
          'x-apisports-key': process.env.FOOTBALL_API_KEY || process.env.API_SPORTS_KEY
        }
      }
    );
    
    if (!response.data.response || response.data.response.length === 0) {
      return res.status(404).json({ error: 'Match not found' });
    }
    
    const match = response.data.response[0];
    
    res.json({
      matchId: match.fixture.id,
      status: match.fixture.status.short,
      minute: match.fixture.status.elapsed,
      isLive: match.fixture.status.short !== 'FT' && 
              match.fixture.status.short !== 'NS',
      homeScore: match.goals.home,
      awayScore: match.goals.away
    });
    
  } catch (error) {
    console.error('❌ Error fetching match:', error);
    res.status(500).json({ error: 'Failed to fetch match data' });
  }
});

app.post('/api/matches/batch', rateLimitBatch, async (req, res) => {
  const { matchIds } = req.body;
  
  // Validasyon
  if (!matchIds || !Array.isArray(matchIds) || matchIds.length === 0) {
    return res.status(400).json({ error: 'matchIds array is required' });
  }
  
  if (matchIds.length > 50) {
    return res.status(400).json({ error: 'Maximum 50 matches per request' });
  }
  
  try {
    // API-Football'a tek seferde istek at
    // Not: API-Football 'ids' parametresi destekliyor
    const idsParam = matchIds.join('-');
    
    const response = await axios.get(
      'https://v3.football.api-sports.io/fixtures',
      {
        params: { ids: idsParam },
        headers: {
          'x-apisports-key': process.env.FOOTBALL_API_KEY || process.env.API_SPORTS_KEY
        }
      }
    );
    
    if (!response.data.response || response.data.response.length === 0) {
      return res.json([]);
    }
    
    // Her maç için data formatla
    const matches = response.data.response.map(match => ({
      matchId: match.fixture.id,
      status: match.fixture.status.short,
      minute: match.fixture.status.elapsed,
      isLive: match.fixture.status.short !== 'FT' && 
              match.fixture.status.short !== 'NS' &&
              match.fixture.status.short !== 'CANC',
      homeScore: match.goals.home || 0,
      awayScore: match.goals.away || 0
    }));
    
    res.json(matches);
    
  } catch (error) {
    console.error('❌ Error fetching batch matches:', error.message);
    res.status(500).json({ error: 'Failed to fetch matches' });
  }
});

app.get('/api/predictions', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM predictions ORDER BY created_at DESC');
    
    // Her prediction için renk çıkar
    for (const pred of result.rows) {
      if (pred.home_logo) {
        pred.home_colors = await getTeamColors(pred.home_logo);
      }
      if (pred.away_logo) {
        pred.away_colors = await getTeamColors(pred.away_logo);
      }
    }
    
    res.json({ success: true, count: result.rows.length, predictions: result.rows });
  } catch (error) {
    console.error('❌ Get predictions:', error);
    res.status(500).json({ success: false, error: 'Failed' });
  }
});

app.get('/api/predictions/active', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM predictions WHERE status = $1 ORDER BY created_at DESC',
      ['active']
    );
    
    // Her prediction için renk çıkar
    for (const pred of result.rows) {
      if (pred.home_logo) {
        pred.home_colors = await getTeamColors(pred.home_logo);
      }
      if (pred.away_logo) {
        pred.away_colors = await getTeamColors(pred.away_logo);
      }
    }
    
    res.json({ success: true, predictions: result.rows });
  } catch (error) {
    console.error('Get active predictions error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/predictions/completed', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM predictions WHERE status = $1 ORDER BY completed_at DESC NULLS LAST, created_at DESC',
      ['completed']
    );
    
    // Her prediction için renk çıkar
    for (const pred of result.rows) {
      if (pred.home_logo) {
        pred.home_colors = await getTeamColors(pred.home_logo);
      }
      if (pred.away_logo) {
        pred.away_colors = await getTeamColors(pred.away_logo);
      }
    }
    
    res.json({ success: true, predictions: result.rows });
  } catch (error) {
    console.error('Get completed predictions error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Test endpoint - Check completed predictions with scores
app.get('/api/test/completed-predictions', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, home_team, away_team, home_score, away_score, status, result, completed_at, prediction_type, match_id
       FROM predictions
       WHERE status = 'completed'
       ORDER BY completed_at DESC NULLS LAST, created_at DESC
       LIMIT 10`
    );
    
    res.json({ 
      success: true, 
      count: result.rows.length,
      predictions: result.rows,
      summary: {
        withScores: result.rows.filter(p => p.home_score !== null && p.home_score !== undefined && p.away_score !== null && p.away_score !== undefined).length,
        withoutScores: result.rows.filter(p => p.home_score === null || p.home_score === undefined || p.away_score === null || p.away_score === undefined).length,
        zeroScores: result.rows.filter(p => p.home_score === 0 && p.away_score === 0).length
      }
    });
  } catch (error) {
    console.error('Test query error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/predictions', async (req, res) => {
  try {
    const { match_id, home_team, away_team, league, prediction_type, odds, confidence, home_logo, away_logo, league_flag, league_logo, home_score, away_score } = req.body;

    if (!match_id || !home_team || !away_team || !prediction_type) {
      return res.status(400).json({ success: false, error: 'Missing fields' });
    }

    const oddsValue = odds && !isNaN(parseFloat(odds)) ? parseFloat(odds) : 0;

    const result = await pool.query(
      `INSERT INTO predictions 
       (match_id, home_team, away_team, league, prediction_type, odds, confidence, status, home_logo, away_logo, league_flag, league_logo, home_score, away_score) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $10, $11, $12, $13) 
       RETURNING *`,
      [match_id, home_team, away_team, league, prediction_type, oddsValue, confidence || 'orta', home_logo || null, away_logo || null, league_flag || null, league_logo || null, home_score || 0, away_score || 0]
    );

    res.status(201).json({ success: true, prediction: result.rows[0] });
  } catch (error) {
    console.error('❌ Create:', error);
    res.status(500).json({ success: false, error: 'Failed' });
  }
});

app.put('/api/predictions/:id/result', async (req, res) => {
  try {
    const { id } = req.params;
    const { result } = req.body;

    await pool.query(
      'UPDATE predictions SET status = $1, result = $1, updated_at = NOW() WHERE id = $2',
      [result, id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Update result:', error);
    res.status(500).json({ success: false, error: 'Failed' });
  }
});

app.delete('/api/predictions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM predictions WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Delete:', error);
    res.status(500).json({ success: false, error: 'Failed' });
  }
});

app.get('/api/cron/update-scores', async (req, res) => {
  try {
    console.log('🕐 [CRON] Checking predictions...');
    // Aktif tahminleri çek
    const predictions = await pool.query(
      'SELECT * FROM predictions WHERE status = $1',
      ['active']
    );

    console.log(`📊 Found ${predictions.rows.length} active predictions`);
    let updated = 0;
    let scoreUpdated = 0;

    for (const pred of predictions.rows) {
      try {
        // Football API'den maç skorunu çek
        const matchData = await fetch(
          `https://v3.football.api-sports.io/fixtures?id=${pred.match_id}`,
          {
            headers: {
              'x-apisports-key': process.env.FOOTBALL_API_KEY
            }
          }
        );
        
        const data = await matchData.json();
        const fixture = data.response[0];
        
        if (!fixture) {
          console.log(`⚠️ No fixture found for match_id: ${pred.match_id}`);
          continue;
        }
        
        const statusShort = fixture.fixture.status.short;
        const homeGoals = fixture.goals.home ?? null;
        const awayGoals = fixture.goals.away ?? null;
        
        // API'den skor gelmiyorsa logla
        if (homeGoals === null || awayGoals === null) {
          console.log(`⚠️ Match ${pred.match_id} - Goals are null: home=${homeGoals}, away=${awayGoals}, status=${statusShort}`);
        }
        
        const homeScore = homeGoals !== null ? homeGoals : 0;
        const awayScore = awayGoals !== null ? awayGoals : 0;
        const total = homeScore + awayScore;
        
        const predType = pred.prediction_type.toUpperCase();
        const isFinished = ["FT", "AET", "PEN"].includes(statusShort);
        const isHT = ["HT", "2H", "FT", "AET", "PEN"].includes(statusShort);
        
        let result = null;
        let shouldUpdate = false;
        let shouldUpdateScore = false;
        
        // FT durumunda skorları her zaman güncelle
        if (isFinished) {
          shouldUpdateScore = true;
          
          // İY (İlk Yarı) tahminleri kontrolü
          if (predType.includes("İY") || predType.includes("IY")) {
            const htScore = fixture.score?.halftime;
            const htTotal = htScore ? (htScore.home || 0) + (htScore.away || 0) : 0;
            
            if (predType.includes("0.5Ü")) result = htTotal > 0.5 ? "won" : "lost";
            else if (predType.includes("1.5Ü")) result = htTotal > 1.5 ? "won" : "lost";
            else if (predType.includes("2.5Ü")) result = htTotal > 2.5 ? "won" : "lost";
            
            shouldUpdate = true;
          }
          // MB (Maç Boyu) tahminleri kontrolü
          else if (predType.includes("MB")) {
            if (predType.includes("0.5Ü")) result = total > 0.5 ? "won" : "lost";
            else if (predType.includes("1.5Ü")) result = total > 1.5 ? "won" : "lost";
            else if (predType.includes("2.5Ü")) result = total > 2.5 ? "won" : "lost";
            else if (predType.includes("3.5Ü")) result = total > 3.5 ? "won" : "lost";
            else if (predType.includes("4.5Ü")) result = total > 4.5 ? "won" : "lost";
            else if (predType.includes("KGV")) result = homeScore > 0 && awayScore > 0 ? "won" : "lost";
            
            shouldUpdate = true;
          }
          // Diğer tahmin tipleri için de skorları güncelle
          else {
            shouldUpdate = true;
            // Result belirlenemediyse null bırak
          }
        }
        // MB tahminleri için canlı maç kontrolü (erken kazanma)
        else if (predType.includes("MB")) {
          const isLive = ["1H", "2H", "HT"].includes(statusShort);
          
          if (isLive) {
            // Erken kazanma kontrolü
            if (predType.includes("0.5Ü")) {
              if (total >= 1) result = "won";
            }
            else if (predType.includes("1.5Ü")) {
              if (total >= 2) result = "won";
            }
            else if (predType.includes("2.5Ü")) {
              if (total >= 3) result = "won";
            }
            else if (predType.includes("3.5Ü")) {
              if (total >= 4) result = "won";
            }
            else if (predType.includes("4.5Ü")) {
              if (total >= 5) result = "won";
            }
            else if (predType.includes("KGV")) {
              if (homeScore > 0 && awayScore > 0) result = "won";
            }
            
            // Kazandıysa hemen güncelle
            if (result === "won") {
              shouldUpdate = true;
              shouldUpdateScore = true;
            }
          }
        }
        // İY tahminleri için HT kontrolü
        else if (predType.includes("İY") || predType.includes("IY")) {
          if (isHT) {
            const htScore = fixture.score?.halftime;
            const htTotal = htScore ? (htScore.home || 0) + (htScore.away || 0) : 0;
            
            if (predType.includes("0.5Ü")) result = htTotal > 0.5 ? "won" : "lost";
            else if (predType.includes("1.5Ü")) result = htTotal > 1.5 ? "won" : "lost";
            else if (predType.includes("2.5Ü")) result = htTotal > 2.5 ? "won" : "lost";
            
            shouldUpdate = true;
            shouldUpdateScore = true;
          }
        }
        
        // Skorları güncelle (FT durumunda her zaman)
        if (shouldUpdateScore) {
          await pool.query(
            'UPDATE predictions SET home_score = $1, away_score = $2, updated_at = NOW() WHERE id = $3',
            [homeScore, awayScore, pred.id]
          );
          scoreUpdated++;
          console.log(`✅ Updated scores for #${pred.id}: ${homeScore}-${awayScore} (status: ${statusShort})`);
        }
        
        // Status ve result güncelle
        if (shouldUpdate && result) {
          await pool.query(
            'UPDATE predictions SET status = $1, result = $2, completed_at = NOW(), updated_at = NOW() WHERE id = $3',
            ['completed', result, pred.id]
          );
          updated++;
          console.log(`✅ Completed prediction #${pred.id}: ${result.toUpperCase()} (${homeScore}-${awayScore})`);
        }
        // FT durumunda result belirlenemediyse sadece status'u güncelle
        else if (isFinished && shouldUpdateScore) {
          await pool.query(
            'UPDATE predictions SET status = $1, completed_at = NOW(), updated_at = NOW() WHERE id = $2',
            ['completed', pred.id]
          );
          updated++;
          console.log(`✅ Completed prediction #${pred.id} (FT, no result logic): ${homeScore}-${awayScore}`);
        }
      } catch (err) {
        console.error(`❌ Error updating prediction #${pred.id}:`, err.message);
      }
    }

    console.log(`✅ Cron job completed: ${updated} predictions completed, ${scoreUpdated} scores updated`);
    res.json({ success: true, updated, scoreUpdated, total: predictions.rows.length });
  } catch (error) {
    console.error('❌ Update scores error:', error);
    res.status(500).json({ error: error.message });
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
      database: 'disconnected'
    });
  }
});

app.get('/', (req, res) => {
  res.json({
    name: 'FlashGoal API',
    version: '5.1.0-cleanup',
    status: 'production'
  });
});

// Auto cleanup cron - every day at 3 AM
cron.schedule("0 3 * * *", async () => {
  try {
    const result = await pool.query(
      `DELETE FROM predictions 
       WHERE created_at < NOW() - INTERVAL '2 days' 
       RETURNING id`
    );
    console.log(`🗑️ Auto cleanup: Deleted ${result.rowCount} old predictions`);
  } catch (error) {
    console.error("❌ Auto cleanup error:", error.message);
  }
});

cron.schedule("*/30 * * * * *", async () => {
  try {
    const { rows } = await pool.query("SELECT * FROM predictions WHERE status = 'active'");
    
    for (const pred of rows) {
      try {
        const response = await axios.get(
          `https://v3.football.api-sports.io/fixtures?id=${pred.match_id}`, 
          { 
            headers: { "x-apisports-key": process.env.FOOTBALL_API_KEY },
            timeout: 5000
          }
        );
        
        const fixture = response.data.response[0];
        if (!fixture) continue;
        
        const statusShort = fixture.fixture.status.short;
        const predType = pred.prediction_type.toUpperCase();
        const homeGoals = fixture.goals.home ?? null;
        const awayGoals = fixture.goals.away ?? null;
        
        // Handle null scores
        const homeScore = homeGoals !== null ? homeGoals : 0;
        const awayScore = awayGoals !== null ? awayGoals : 0;
        const total = homeScore + awayScore;
        
        const htScore = fixture.score?.halftime;
        const htTotal = htScore ? (htScore.home || 0) + (htScore.away || 0) : 0;
        
        const isFinished = ["FT", "AET", "PEN"].includes(statusShort);
        const isHT = ["HT", "2H", "FT", "AET", "PEN"].includes(statusShort);
        
        let result = null;
        let shouldUpdate = false;
        let shouldUpdateScore = false;
        
        // FT durumunda skorları her zaman güncelle
        if (isFinished) {
          shouldUpdateScore = true;
        }
        
        // İY (İlk Yarı) tahminleri - HT'de kontrol et
        if (predType.includes("İY") || predType.includes("IY")) {
          if (isHT) {
            if (predType.includes("0.5Ü")) result = htTotal > 0.5 ? "won" : "lost";
            else if (predType.includes("1.5Ü")) result = htTotal > 1.5 ? "won" : "lost";
            else if (predType.includes("2.5Ü")) result = htTotal > 2.5 ? "won" : "lost";
            shouldUpdate = true;
          }
        } 
        // MB (Maç Boyu) tahminleri - Canlı maçta erken kazanma kontrolü
        else if (predType.includes("MB")) {
          const isLive = ["1H", "2H", "HT", "FT", "AET", "PEN"].includes(statusShort);
          
          if (isLive) {
            // MB tahminleri için erken kazanma kontrolü
            if (predType.includes("0.5Ü")) {
              if (total >= 1) result = "won"; // 0.5Ü için 1+ gol = kazandı
              else if (isFinished) result = "lost"; // Maç bitti ve 0 gol = kaybetti
            }
            else if (predType.includes("1.5Ü")) {
              if (total >= 2) result = "won"; // 1.5Ü için 2+ gol = kazandı
              else if (isFinished) result = "lost"; // Maç bitti ve <2 gol = kaybetti
            }
            else if (predType.includes("2.5Ü")) {
              if (total >= 3) result = "won"; // 2.5Ü için 3+ gol = kazandı
              else if (isFinished) result = "lost"; // Maç bitti ve <3 gol = kaybetti
            }
            else if (predType.includes("3.5Ü")) {
              if (total >= 4) result = "won"; // 3.5Ü için 4+ gol = kazandı
              else if (isFinished) result = "lost"; // Maç bitti ve <4 gol = kaybetti
            }
            else if (predType.includes("4.5Ü")) {
              if (total >= 5) result = "won"; // 4.5Ü için 5+ gol = kazandı
              else if (isFinished) result = "lost"; // Maç bitti ve <5 gol = kaybetti
            }
            else if (predType.includes("KGV")) {
              if (homeScore > 0 && awayScore > 0) result = "won"; // Her iki takım gol attı
              else if (isFinished) result = "lost"; // Maç bitti ve bir takım gol atmadı
            }
            
            // Eğer kazandıysa hemen güncelle, kaybetti ise sadece maç bittiyse güncelle
            if (result === "won" || (result === "lost" && isFinished)) {
              shouldUpdate = true;
            }
          }
        }
        
        // Skorları güncelle (FT durumunda her zaman)
        if (shouldUpdateScore) {
          await pool.query(
            "UPDATE predictions SET home_score = $1, away_score = $2, updated_at = NOW() WHERE id = $3",
            [homeScore, awayScore, pred.id]
          );
        }
        
        // Status ve result güncelle
        if (shouldUpdate && result) {
          await pool.query(
            "UPDATE predictions SET status = 'completed', result = $1, completed_at = NOW(), home_score = $2, away_score = $3, updated_at = NOW() WHERE id = $4",
            [result, homeScore, awayScore, pred.id]
          );
          const liveStatus = ["1H", "2H", "HT"].includes(statusShort) ? " (LIVE)" : "";
          console.log(`✅ #${pred.id}: ${result.toUpperCase()}${liveStatus} - ${homeScore}-${awayScore}`);
        }
        // FT durumunda result belirlenemediyse sadece status'u güncelle
        else if (isFinished && shouldUpdateScore) {
          await pool.query(
            "UPDATE predictions SET status = 'completed', completed_at = NOW(), home_score = $1, away_score = $2, updated_at = NOW() WHERE id = $3",
            [homeScore, awayScore, pred.id]
          );
          console.log(`✅ #${pred.id}: Completed (FT) - ${homeScore}-${awayScore}`);
        }
      } catch (err) {
        console.error(`❌ Check #${pred.id}:`, err.message);
      }
    }
  } catch (error) {
    console.error("❌ Cron:", error.message);
  }
});


// ==========================================
// REVENUECAT WEBHOOK
// ==========================================

app.post("/api/webhook/revenuecat", async (req, res) => {
  try {
    const event = req.body;
    console.log("🔔 RevenueCat webhook:", event.type);
    
    if (event.type === "INITIAL_PURCHASE" || event.type === "RENEWAL") {
      const userId = event.app_user_id;
      const productId = event.product_id;
      
      if (productId === "com.flashgoal.vip.24h") {
        const expiryDate = new Date();
        expiryDate.setHours(expiryDate.getHours() + 24);
        
        await pool.query(
          `INSERT INTO vip_access (user_id, expiry_date, product_id) 
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id) 
           DO UPDATE SET expiry_date = $2, product_id = $3, updated_at = NOW()`,
          [userId, expiryDate, productId]
        );
        console.log(`✅ 24h VIP activated for user: ${userId}`);
      } else {
        const expiryDate = new Date(event.expiration_at_ms);
        await pool.query(
          `INSERT INTO vip_access (user_id, expiry_date, product_id) 
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id) 
           DO UPDATE SET expiry_date = $2, product_id = $3, updated_at = NOW()`,
          [userId, expiryDate, productId]
        );
        console.log(`✅ Subscription activated for user: ${userId}`);
      }
    }
    res.status(200).send("OK");
  } catch (error) {
    console.error("❌ Webhook error:", error);
    res.status(500).send("Error");
  }
});

app.get("/api/vip/check/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(
      `SELECT * FROM vip_access WHERE user_id = $1 AND expiry_date > NOW()`,
      [userId]
    );
    const isVIP = result.rows.length > 0;
    const expiryDate = isVIP ? result.rows[0].expiry_date : null;
    res.json({ success: true, isVIP, expiryDate, productId: isVIP ? result.rows[0].product_id : null });
  } catch (error) {
    console.error("Error checking VIP:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Cron job - her 10 dakikada skorları güncelle
cron.schedule('*/10 * * * *', async () => {
  console.log('🕐 [10MIN CRON] Running cron job - updating match scores...');
  try {
    const apiUrl = process.env.RAILWAY_PUBLIC_DOMAIN 
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/api/cron/update-scores`
      : `http://localhost:${PORT}/api/cron/update-scores`;
    
    console.log(`📡 Calling: ${apiUrl}`);
    const response = await fetch(apiUrl);
    const data = await response.json();
    console.log('✅ [10MIN CRON] Cron job completed:', data);
  } catch (error) {
    console.error('❌ [10MIN CRON] Cron job failed:', error.message);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 FlashGoal API v5.1 - Port ${PORT}`);

// ===================== STRIPE PAYMENT ENDPOINTS =====================
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
if (process.env.STRIPE_SECRET_KEY) {
  console.log('✅ Stripe initialized');
} else {
  console.error('❌ STRIPE_SECRET_KEY missing!');
}
// Create payment intent
app.post('/api/payments/create-intent', async (req, res) => {
  console.log('🟢 ONE-TIME PAYMENT!');
  console.log('Body:', req.body);

  try {
    const { priceId, userId, email } = req.body;
    
    if (!priceId || !email) {
      return res.status(400).json({ success: false, error: 'Missing fields' });
    }
    
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: 'https://app.flashgoal.app/user/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://app.flashgoal.app/user/vip',
      customer_email: email,
      metadata: { userId: userId || 'unknown', type: 'one-time' }
    });

    console.log('✅ Session:', session.id);
    res.json({ success: true, url: session.url, sessionId: session.id });

  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Subscription endpoint
app.post('/api/payments/create-subscription', async (req, res) => {
  console.log('🔵 ENDPOINT HIT!');
  console.log('🔵 Body:', req.body);
  
  try {
    const { priceId, userId, email } = req.body;
    
    if (!priceId || !email) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{
        price: priceId,
        quantity: 1,
      }],
      success_url: 'https://app.flashgoal.app/user/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://app.flashgoal.app/user/vip',
      customer_email: email,
      metadata: {
        userId: userId || 'unknown'
      }
    });

    console.log('✅ Checkout Session created:', session.id);
    
    res.json({
      success: true,
      url: session.url
    });
    
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Verify payment and activate VIP
app.post('/api/payments/verify', async (req, res) => {
  try {
    const { paymentIntentId, userId, productId, days } = req.body;

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status === 'succeeded') {
      const expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() + days);

      await pool.query(
        `INSERT INTO vip_access (user_id, product_id, expiry_date) 
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) 
         DO UPDATE SET product_id = $2, expiry_date = $3`,
        [userId, productId, expiryDate]
      );

      res.json({ 
        success: true, 
        message: 'VIP activated',
        expiryDate: expiryDate
      });
    } else {
      res.status(400).json({ success: false, error: 'Payment not completed' });
    }
  } catch (error) {
    console.error('Payment verification error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get Stripe publishable key
app.get('/api/payments/config', (req, res) => {
  res.json({ 
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY 
  });
});

});

