require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const axios = require('axios');
const cron = require("node-cron");
const getColors = require('get-image-colors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;

// CORS middleware - EN ÜSTTE OLMALI (tüm route'lardan önce)
app.use(cors({
  origin: '*', // Tüm origin'lere izin ver
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: false // Cookie-based auth kullanmıyorsak false
}));

// OPTIONS request'leri için preflight handling
app.options('*', cors());

app.use(express.json());

// Static files middleware - CORS ve body-parser'dan sonra, routes'tan ÖNCE
app.use('/static', express.static(path.join(__dirname, 'public')));

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

// JWT SECRET
const JWT_SECRET = process.env.JWT_SECRET || 'flashgoal-secret-2025';

// EMAIL TRANSPORTER
const emailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER || 'your-email@gmail.com',
    pass: process.env.EMAIL_PASS || 'your-app-password'
  }
});

// ==========================================
// TEAM COLORS DATABASE
// ==========================================

const TEAM_COLORS = {
  // TÜRKİYE SÜPER LİG
  'Galatasaray': ['#FDB913', '#C8102E'],
  'Fenerbahçe': ['#FFED00', '#001489'],
  'Fenerbahce': ['#FFED00', '#001489'], // Alternatif yazım
  'Beşiktaş': ['#000000', '#FFFFFF'],
  'Besiktas': ['#000000', '#FFFFFF'],
  'Trabzonspor': ['#780109', '#7CCDEF'],
  'Başakşehir': ['#F26522', '#00205B'],
  'Basaksehir': ['#F26522', '#00205B'],

  // İNGİLTERE PREMIER LEAGUE
  'Arsenal': ['#EF0107', '#FFFFFF'],
  'Liverpool': ['#C8102E', '#00B2A9'],
  'Manchester United': ['#DA291C', '#FBE122'],
  'Man United': ['#DA291C', '#FBE122'],
  'Manchester City': ['#6CABDD', '#1C2C5B'],
  'Man City': ['#6CABDD', '#1C2C5B'],
  'Chelsea': ['#034694', '#DBA111'],
  'Tottenham': ['#132257', '#FFFFFF'],
  'Tottenham Hotspur': ['#132257', '#FFFFFF'],
  'Leicester City': ['#003090', '#FDBE11'],
  'West Ham': ['#7A263A', '#1BB1E7'],
  'Everton': ['#003399', '#FFFFFF'],
  'Newcastle': ['#000000', '#FFFFFF'],
  'Newcastle United': ['#000000', '#FFFFFF'],

  // İSPANYA LA LIGA
  'Barcelona': ['#A50044', '#004D98'],
  'FC Barcelona': ['#A50044', '#004D98'],
  'Real Madrid': ['#FFFFFF', '#00529F'],
  'Atletico Madrid': ['#CE3524', '#1A355C'],
  'Atlético Madrid': ['#CE3524', '#1A355C'],
  'Sevilla': ['#D6001C', '#FFFFFF'],
  'Valencia': ['#EE3524', '#000000'],
  'Athletic Bilbao': ['#EE2523', '#000000'],
  'Villarreal': ['#FFE667', '#005187'],

  // İTALYA SERIE A
  'Juventus': ['#000000', '#FFFFFF'],
  'AC Milan': ['#FB090B', '#000000'],
  'Inter Milan': ['#0068A8', '#000000'],
  'Inter': ['#0068A8', '#000000'],
  'Napoli': ['#007FFF', '#FFFFFF'],
  'Roma': ['#8B0304', '#F7B500'],
  'AS Roma': ['#8B0304', '#F7B500'],
  'Lazio': ['#87CEEB', '#FFFFFF'],

  // ALMANYA BUNDESLIGA
  'Bayern Munich': ['#DC052D', '#0066B2'],
  'Bayern München': ['#DC052D', '#0066B2'],
  'Bayern': ['#DC052D', '#0066B2'],
  'Borussia Dortmund': ['#FDE100', '#000000'],
  'Dortmund': ['#FDE100', '#000000'],
  'RB Leipzig': ['#DD0741', '#FFFFFF'],
  'Leipzig': ['#DD0741', '#FFFFFF'],
  'Bayer Leverkusen': ['#E32221', '#000000'],

  // FRANSA LIGUE 1
  'PSG': ['#004170', '#DA291C'],
  'Paris Saint-Germain': ['#004170', '#DA291C'],
  'Paris SG': ['#004170', '#DA291C'],
  'Lyon': ['#BE0E2C', '#0E2B5C'],
  'Marseille': ['#2FAEE0', '#FFFFFF'],
  'Monaco': ['#C8102E', '#FFFFFF'],

  // PORTEKİZ
  'Porto': ['#003C7E', '#FFFFFF'],
  'FC Porto': ['#003C7E', '#FFFFFF'],
  'Benfica': ['#D20222', '#FFFFFF'],
  'Sporting': ['#095D41', '#FFFFFF'],
  'Sporting CP': ['#095D41', '#FFFFFF'],

  // HOLLANDA
  'Ajax': ['#D2122E', '#FFFFFF'],
  'PSV': ['#ED1C24', '#FFFFFF'],
  'PSV Eindhoven': ['#ED1C24', '#FFFFFF'],
  'Feyenoord': ['#CC0000', '#FFFFFF'],

  // İSKOÇYA
  'Celtic': ['#009B48', '#FFFFFF'],
  'Celtic FC': ['#009B48', '#FFFFFF'],
  'Rangers': ['#0F47AF', '#C8102E'],
  'Rangers FC': ['#0F47AF', '#C8102E']
};

// Get team colors from database by team name
function getTeamColorsFromDatabase(teamName) {
  if (!teamName) return null;
  
  // Takım adını normalize et (case-insensitive)
  const normalizedName = teamName.trim();
  
  // Önce database'e bak
  if (TEAM_COLORS[normalizedName]) {
    return TEAM_COLORS[normalizedName];
  }
  
  // Case-insensitive arama
  const lowerName = normalizedName.toLowerCase();
  for (const [key, colors] of Object.entries(TEAM_COLORS)) {
    if (key.toLowerCase() === lowerName) {
      return colors;
    }
  }
  
  // Bulamazsa null döndür (logo extraction kullanılacak)
  return null;
}

// Extract colors from logo URL (fallback)
async function extractColorsFromLogo(logoUrl) {
  try {
    const colors = await getColors(logoUrl);
    return colors.slice(0, 2).map(c => c.hex());
  } catch (error) {
    console.error('Color extract error:', error);
    return ['#10B981', '#3B82F6']; // Default yeşil-mavi
  }
}

// Get team colors - tries database first, then logo extraction
async function getTeamColors(teamName, logoUrl) {
  // First try database
  const dbColors = getTeamColorsFromDatabase(teamName);
  if (dbColors) {
    return dbColors;
  }
  
  // Fallback to logo extraction if logo URL provided
  if (logoUrl) {
    return await extractColorsFromLogo(logoUrl);
  }
  
  // Default colors if nothing found
  return ['#10B981', '#3B82F6'];
}

// League and country flag mapping
const LEAGUE_FLAGS = {
  // League names
  'premier league': '🇬🇧',
  'premier': '🇬🇧',
  'la liga': '🇪🇸',
  'serie a': '🇮🇹',
  'serie b': '🇮🇹',
  'bundesliga': '🇩🇪',
  'ligue 1': '🇫🇷',
  'ligue 2': '🇫🇷',
  'super lig': '🇹🇷',
  'süper lig': '🇹🇷',
  'superliga': '🇹🇷',
  'primeira liga': '🇵🇹',
  'eredivisie': '🇳🇱',
  'champions league': '🏆',
  'europa league': '🇪🇺',
  'ucl': '🏆',
  'uel': '🇪🇺',
  
  // Countries
  'turkey': '🇹🇷',
  'türkiye': '🇹🇷',
  'turkiye': '🇹🇷',
  'turkish': '🇹🇷',
  'england': '🇬🇧',
  'english': '🇬🇧',
  'ingiltere': '🇬🇧',
  'spain': '🇪🇸',
  'ispanya': '🇪🇸',
  'spanish': '🇪🇸',
  'italy': '🇮🇹',
  'italya': '🇮🇹',
  'italian': '🇮🇹',
  'germany': '🇩🇪',
  'almanya': '🇩🇪',
  'german': '🇩🇪',
  'france': '🇫🇷',
  'fransa': '🇫🇷',
  'french': '🇫🇷',
  'portugal': '🇵🇹',
  'portekiz': '🇵🇹',
  'portuguese': '🇵🇹',
  'netherlands': '🇳🇱',
  'holland': '🇳🇱',
  'hollanda': '🇳🇱',
  'dutch': '🇳🇱',
  'scotland': '🇬🇧',
  'iskocya': '🇬🇧',
  'scottish': '🇬🇧',
  'hungary': '🇭🇺',
  'macaristan': '🇭🇺',
  'hungarian': '🇭🇺',
  'brazil': '🇧🇷',
  'brezilya': '🇧🇷',
  'brazilian': '🇧🇷',
  'argentina': '🇦🇷',
  'arjantin': '🇦🇷',
  'argentinian': '🇦🇷',
  'mexico': '🇲🇽',
  'meksika': '🇲🇽',
  'mexican': '🇲🇽',
  'usa': '🇺🇸',
  'united states': '🇺🇸',
  'america': '🇺🇸',
  'russia': '🇷🇺',
  'rusya': '🇷🇺',
  'russian': '🇷🇺',
  'poland': '🇵🇱',
  'polonya': '🇵🇱',
  'polish': '🇵🇱',
  'czech': '🇨🇿',
  'czech republic': '🇨🇿',
  'greece': '🇬🇷',
  'yunanistan': '🇬🇷',
  'greek': '🇬🇷',
  'belgium': '🇧🇪',
  'belcika': '🇧🇪',
  'belgian': '🇧🇪',
  'austria': '🇦🇹',
  'avusturya': '🇦🇹',
  'austrian': '🇦🇹',
  'switzerland': '🇨🇭',
  'isvicre': '🇨🇭',
  'swiss': '🇨🇭',
  'croatia': '🇭🇷',
  'hrvatska': '🇭🇷',
  'croatian': '🇭🇷',
  'serbia': '🇷🇸',
  'sirbistan': '🇷🇸',
  'serbian': '🇷🇸',
  'romania': '🇷🇴',
  'romanya': '🇷🇴',
  'romanian': '🇷🇴',
  'ukraine': '🇺🇦',
  'ukrayna': '🇺🇦',
  'ukrainian': '🇺🇦',
  'sweden': '🇸🇪',
  'isvec': '🇸🇪',
  'swedish': '🇸🇪',
  'chile': '🇨🇱',
  'sili': '🇨🇱',
  'chilean': '🇨🇱'
};

// Get league flag from league name
function getLeagueFlag(leagueName) {
  if (!leagueName) return '🌍';
  
  const normalizedLeague = leagueName.toLowerCase().trim();
  
  // Önce tam eşleşme kontrolü
  if (LEAGUE_FLAGS[normalizedLeague]) {
    return LEAGUE_FLAGS[normalizedLeague];
  }
  
  // " - Country" formatını kontrol et (örn: "NB I - Hungary", "Serie B - Brazil")
  // Bu format daha spesifik olduğu için kısmi eşleşmeden önce kontrol edilmeli
  if (normalizedLeague.includes(' - ')) {
    const parts = normalizedLeague.split(' - ');
    if (parts.length >= 2) {
      const country = parts[1].trim(); // "hungary", "brazil" (zaten lowercase)
      
      // Önce tam eşleşme kontrolü
      if (LEAGUE_FLAGS[country]) {
        return LEAGUE_FLAGS[country];
      }
      
      // Ülke adına göre flag ara - tam eşleşme veya kısmi eşleşme
      for (const [key, flag] of Object.entries(LEAGUE_FLAGS)) {
        const lowerKey = key.toLowerCase();
        // Tam eşleşme veya country key'in içinde geçiyorsa
        if (country === lowerKey || country.includes(lowerKey) || lowerKey.includes(country)) {
          return flag;
        }
      }
    }
  }
  
  // Kısmi eşleşme - league/ülke adını ara
  for (const [key, flag] of Object.entries(LEAGUE_FLAGS)) {
    if (normalizedLeague.includes(key.toLowerCase())) {
      return flag;
    }
  }
  
  // Default fallback
  return '🌍';
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
        is_urgent BOOLEAN DEFAULT FALSE,
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
    
    // Add is_urgent column if it doesn't exist (for existing tables)
    try {
      await pool.query(`
        ALTER TABLE predictions 
        ADD COLUMN IF NOT EXISTS is_urgent BOOLEAN DEFAULT FALSE
      `);
      console.log('✅ is_urgent column added');
    } catch (error) {
      if (!error.message.includes('does not exist')) {
        console.log('ℹ️ is_urgent column already exists');
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
    
    // ==========================================
    // REFERRAL SYSTEM - Database Schema
    // ==========================================
    
    // Add referral columns to users table
    try {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(20)`);
      // Try to add unique constraint (ignore if already exists)
      try {
        await pool.query(`ALTER TABLE users ADD CONSTRAINT users_referral_code_unique UNIQUE (referral_code)`);
      } catch (err) {
        // Constraint might already exist, ignore
      }
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by VARCHAR(20)`);
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_count INT DEFAULT 0`);
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS vip_bonus_days INT DEFAULT 0`);
      console.log('✅ Referral columns added to users table');
    } catch (error) {
      // Ignore "already exists" errors
      if (!error.message.includes('already exists') && !error.message.includes('duplicate')) {
        console.log('ℹ️ Users table referral columns check:', error.message);
      }
    }
    
    // Create referrals table
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS referrals (
          id SERIAL PRIMARY KEY,
          referrer_code VARCHAR(20) NOT NULL,
          referrer_user_id INT,
          referred_user_id INT,
          referred_email VARCHAR(255),
          status VARCHAR(20) DEFAULT 'completed',
          bonus_given BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('✅ Referrals table ready');
    } catch (error) {
      if (!error.message.includes('already exists')) {
        console.log('ℹ️ Referrals table check:', error.message);
      }
    }
    
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
    
    // Her prediction için renk çıkar ve league_flag'i düzelt
    for (const pred of result.rows) {
      pred.home_colors = await getTeamColors(pred.home_team, pred.home_logo);
      pred.away_colors = await getTeamColors(pred.away_team, pred.away_logo);
      
      // League flag düzelt
      if (!pred.league_flag || pred.league_flag === '🌍') {
        pred.league_flag = getLeagueFlag(pred.league);
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
    
    // Her prediction için renk çıkar ve league_flag'i düzelt
    for (const pred of result.rows) {
      pred.home_colors = await getTeamColors(pred.home_team, pred.home_logo);
      pred.away_colors = await getTeamColors(pred.away_team, pred.away_logo);
      
      // League flag düzelt
      if (!pred.league_flag || pred.league_flag === '🌍') {
        pred.league_flag = getLeagueFlag(pred.league);
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
    
    // Her prediction için renk çıkar ve league_flag'i düzelt
    for (const pred of result.rows) {
      pred.home_colors = await getTeamColors(pred.home_team, pred.home_logo);
      pred.away_colors = await getTeamColors(pred.away_team, pred.away_logo);
      
      // Database'de kaydedilen flag'i override et - eğer 🌍 ise league adından belirle
      pred.league_flag = pred.league_flag === '🌍' || !pred.league_flag
        ? getLeagueFlag(pred.league)
        : pred.league_flag;
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
    const { match_id, home_team, away_team, league, prediction_type, odds, confidence, home_logo, away_logo, league_flag, league_logo, home_score, away_score, is_urgent } = req.body;

    if (!match_id || !home_team || !away_team || !prediction_type) {
      return res.status(400).json({ success: false, error: 'Missing fields' });
    }

    const oddsValue = odds && !isNaN(parseFloat(odds)) ? parseFloat(odds) : 0;
    const isUrgentValue = is_urgent === true || is_urgent === 'true';

    const result = await pool.query(
      `INSERT INTO predictions 
       (match_id, home_team, away_team, league, prediction_type, odds, confidence, status, home_logo, away_logo, league_flag, league_logo, home_score, away_score, is_urgent) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $10, $11, $12, $13, $14) 
       RETURNING *`,
      [match_id, home_team, away_team, league, prediction_type, oddsValue, confidence || 'orta', home_logo || null, away_logo || null, league_flag || null, league_logo || null, home_score || 0, away_score || 0, isUrgentValue]
    );

    const prediction = result.rows[0];
    
    // Get team colors - try database first, then logo extraction
    const homeColors = await getTeamColors(home_team, home_logo);
    const awayColors = await getTeamColors(away_team, away_logo);
    
    // Add colors to prediction object
    prediction.home_colors = homeColors;
    prediction.away_colors = awayColors;

    res.status(201).json({ success: true, prediction: prediction });
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
    // Aktif ve tamamlanmış tahminleri çek (FT olunca skorları güncellemek için)
    const predictions = await pool.query(
      'SELECT * FROM predictions WHERE status IN ($1, $2)',
      ['active', 'completed']
    );

    console.log(`📊 Found ${predictions.rows.length} predictions to check`);
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
        const isLive = ["1H", "2H", "HT"].includes(statusShort);
        
        let result = null;
        let shouldUpdateResult = false;
        let shouldUpdateScore = false;
        
        // 1. EĞER MAÇ BİTTİYSE: Tüm tahminlerin skorlarını güncelle
        if (isFinished) {
          shouldUpdateScore = true;  // Her zaman final skorları yaz
          
          // Result henüz belirlenmemişse (active veya result=null), belirle
          if (pred.result === null || pred.status === 'active') {
            shouldUpdateResult = true;
            
            // İY tahminleri
            if (predType.includes("İY") || predType.includes("IY")) {
              const htScore = fixture.score?.halftime;
              const htTotal = htScore ? (htScore.home || 0) + (htScore.away || 0) : 0;
              
              if (predType.includes("0.5Ü")) result = htTotal > 0.5 ? "won" : "lost";
              else if (predType.includes("1.5Ü")) result = htTotal > 1.5 ? "won" : "lost";
              else if (predType.includes("2.5Ü")) result = htTotal > 2.5 ? "won" : "lost";
            }
            // MB tahminleri
            else if (predType.includes("MB")) {
              if (predType.includes("0.5Ü")) result = total > 0.5 ? "won" : "lost";
              else if (predType.includes("1.5Ü")) result = total > 1.5 ? "won" : "lost";
              else if (predType.includes("2.5Ü")) result = total > 2.5 ? "won" : "lost";
              else if (predType.includes("3.5Ü")) result = total > 3.5 ? "won" : "lost";
              else if (predType.includes("4.5Ü")) result = total > 4.5 ? "won" : "lost";
              else if (predType.includes("KGV")) result = homeScore > 0 && awayScore > 0 ? "won" : "lost";
            }
          }
        }
        
        // 2. CANLİ MAÇTA ERKEN KAZANMA KONTROLÜ
        else if (isLive && pred.result === null) {
          // İY tahminleri
          if (predType.includes("İY") || predType.includes("IY")) {
            if (statusShort === "HT" || statusShort === "2H") {
              const htScore = fixture.score?.halftime;
              const htTotal = htScore ? (htScore.home || 0) + (htScore.away || 0) : 0;
              
              if (predType.includes("0.5Ü") && htTotal > 0.5) result = "won";
              else if (predType.includes("1.5Ü") && htTotal > 1.5) result = "won";
              else if (predType.includes("2.5Ü") && htTotal > 2.5) result = "won";
              
              if (result === "won") {
                shouldUpdateResult = true;
                shouldUpdateScore = true;
              }
            }
          }
          // MB tahminleri - erken kazanma
          else if (predType.includes("MB")) {
            if (predType.includes("0.5Ü") && total >= 1) result = "won";
            else if (predType.includes("1.5Ü") && total >= 2) result = "won";
            else if (predType.includes("2.5Ü") && total >= 3) result = "won";
            else if (predType.includes("3.5Ü") && total >= 4) result = "won";
            else if (predType.includes("4.5Ü") && total >= 5) result = "won";
            else if (predType.includes("KGV") && homeScore > 0 && awayScore > 0) result = "won";
            
            if (result === "won") {
              shouldUpdateResult = true;
              shouldUpdateScore = true;
            }
          }
        }
        
        // 3. DATABASE UPDATE
        
        // Sadece skor güncelleme (result değişmez)
        if (shouldUpdateScore && !shouldUpdateResult) {
          await pool.query(
            'UPDATE predictions SET home_score = $1, away_score = $2, updated_at = NOW() WHERE id = $3',
            [homeScore, awayScore, pred.id]
          );
          scoreUpdated++;
          console.log(`📊 Updated scores for #${pred.id}: ${homeScore}-${awayScore}`);
        }
        
        // Skor + result güncelleme
        if (shouldUpdateScore && shouldUpdateResult && result) {
          await pool.query(
            'UPDATE predictions SET home_score = $1, away_score = $2, status = $3, result = $4, completed_at = NOW(), updated_at = NOW() WHERE id = $5',
            [homeScore, awayScore, 'completed', result, pred.id]
          );
          updated++;
          console.log(`✅ Completed #${pred.id}: ${result.toUpperCase()} (${homeScore}-${awayScore})`);
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
// REFERRAL SYSTEM - Helper Functions
// ==========================================

// Generate unique referral code (6 characters: uppercase + number)
async function generateReferralCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const numbers = '0123456789';
  let code;
  let exists = true;
  
  while (exists) {
    // Generate 4 uppercase letters + 2 numbers
    const letters = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const nums = Array.from({ length: 2 }, () => numbers[Math.floor(Math.random() * numbers.length)]).join('');
    code = letters + nums;
    
    // Check if code already exists
    const result = await pool.query('SELECT id FROM users WHERE referral_code = $1', [code]);
    exists = result.rows.length > 0;
  }
  
  return code;
}

// Add VIP days to user (extend existing or create new)
async function addVIPDays(userId, days) {
  try {
    // Check if user has existing VIP
    const existing = await pool.query(
      'SELECT expiry_date FROM vip_access WHERE user_id = $1',
      [userId]
    );
    
    let expiryDate;
    if (existing.rows.length > 0 && existing.rows[0].expiry_date) {
      // Extend existing VIP
      const currentExpiry = new Date(existing.rows[0].expiry_date);
      expiryDate = new Date(currentExpiry);
      expiryDate.setDate(expiryDate.getDate() + days);
    } else {
      // Create new VIP
      expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() + days);
    }
    
    await pool.query(
      `INSERT INTO vip_access (user_id, expiry_date, product_id) 
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) 
       DO UPDATE SET expiry_date = $2, updated_at = NOW()`,
      [userId, expiryDate, 'referral_bonus']
    );
    
    return expiryDate;
  } catch (error) {
    console.error('Error adding VIP days:', error);
    throw error;
  }
}

// ==========================================
// REFERRAL SYSTEM - API Endpoints
// ==========================================

// GET /api/user/referral-info
app.get('/api/user/referral-info', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ success: false, error: 'userId is required' });
    }
    
    const result = await pool.query(
      'SELECT referral_code, referral_count, vip_bonus_days, referred_by FROM users WHERE id = $1',
      [userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    const user = result.rows[0];
    res.json({
      success: true,
      referral_code: user.referral_code || null,
      referral_count: user.referral_count || 0,
      vip_bonus_days: user.vip_bonus_days || 0,
      referred_by: user.referred_by || null
    });
  } catch (error) {
    console.error('❌ Get referral info error:', error);
    res.status(500).json({ success: false, error: 'Failed to get referral info' });
  }
});

// POST /api/referral/validate
app.post('/api/referral/validate', async (req, res) => {
  try {
    const { referral_code } = req.body;
    
    if (!referral_code) {
      return res.status(400).json({ success: false, valid: false, message: 'Referral code is required' });
    }
    
    // Check if referral code exists
    const result = await pool.query(
      'SELECT id, referral_count FROM users WHERE referral_code = $1',
      [referral_code.toUpperCase()]
    );
    
    if (result.rows.length === 0) {
      return res.json({ success: true, valid: false, message: 'Invalid referral code' });
    }
    
    const user = result.rows[0];
    const referralCount = user.referral_count || 0;
    
    // Check if referrer has reached max quota (2)
    if (referralCount >= 2) {
      return res.json({ 
        success: true, 
        valid: false, 
        message: 'This referral code has reached its maximum referrals' 
      });
    }
    
    res.json({ success: true, valid: true, message: 'Referral code is valid' });
  } catch (error) {
    console.error('❌ Validate referral error:', error);
    res.status(500).json({ success: false, valid: false, message: 'Failed to validate referral code' });
  }
});

// GET /api/referral/history
app.get('/api/referral/history', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ success: false, error: 'userId is required' });
    }
    
    const result = await pool.query(
      `SELECT referred_email, created_at, bonus_given 
       FROM referrals 
       WHERE referrer_user_id = $1 
       ORDER BY created_at DESC`,
      [userId]
    );
    
    res.json({
      success: true,
      referrals: result.rows.map(row => ({
        referred_email: row.referred_email,
        created_at: row.created_at,
        bonus_given: row.bonus_given
      }))
    });
  } catch (error) {
    console.error('❌ Get referral history error:', error);
    res.status(500).json({ success: false, error: 'Failed to get referral history' });
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

// ============================================
// AUTH ENDPOINTS
// ============================================

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name, referralCode } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password required' });
    }
    
    // Check if exists
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ success: false, error: 'Email already registered' });
    }
    
    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);
    
    // Generate referral code
    const newReferralCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    
    // Insert user
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, name, referral_code, referred_by) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING id, email, name, referral_code`,
      [email, passwordHash, name, newReferralCode, referralCode]
    );
    
    const user = result.rows[0];
    
    // Generate token
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    
    res.json({ 
      success: true, 
      token, 
      userId: user.id,
      user: { email: user.email, name: user.name }
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ success: false, error: 'Registration failed' });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Get user
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    
    const user = result.rows[0];
    
    // Check password
    const valid = await bcrypt.compare(password, user.password_hash);
    
    if (!valid) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    
    // Check VIP status
    const vipCheck = await pool.query(
      'SELECT * FROM vip_access WHERE user_id = $1 AND expiry_date > NOW()',
      [user.id.toString()]
    );
    
    const isVIP = vipCheck.rows.length > 0;
    const vipExpiresAt = isVIP ? vipCheck.rows[0].expiry_date : null;
    
    // Generate token
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    
    res.json({ 
      success: true, 
      token, 
      userId: user.id,
      isVIP,
      vipExpiresAt,
      user: { email: user.email, name: user.name }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, error: 'Login failed' });
  }
});

// GET /api/auth/validate
app.get('/api/auth/validate', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.json({ valid: false });
    }
    
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Check if user still exists
    const result = await pool.query('SELECT id FROM users WHERE id = $1', [decoded.userId]);
    
    if (result.rows.length === 0) {
      return res.json({ valid: false });
    }
    
    res.json({ valid: true, userId: decoded.userId });
  } catch (error) {
    res.json({ valid: false });
  }
});

// POST /api/auth/forgot-password
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    
    if (result.rows.length === 0) {
      // Don't reveal if email exists
      return res.json({ success: true });
    }
    
    const user = result.rows[0];
    
    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetExpires = Date.now() + 15 * 60 * 1000; // 15 minutes
    
    await pool.query(
      'UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3',
      [resetToken, resetExpires, user.id]
    );
    
    // Send email
    const resetLink = `flashgoal://reset-password?token=${resetToken}`;
    
    await emailTransporter.sendMail({
      to: email,
      subject: 'FlashGoal - Şifre Sıfırlama',
      html: `
        <h2>Şifre Sıfırlama</h2>
        <p>Şifrenizi sıfırlamak için aşağıdaki linke tıklayın:</p>
        <a href="${resetLink}">Şifremi Sıfırla</a>
        <p>Bu link 15 dakika geçerlidir.</p>
      `
    });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ success: false, error: 'Failed to send reset email' });
  }
});

// POST /api/auth/reset-password
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    
    const result = await pool.query(
      'SELECT * FROM users WHERE reset_token = $1 AND reset_token_expires > $2',
      [token, Date.now()]
    );
    
    if (result.rows.length === 0) {
      return res.status(400).json({ success: false, error: 'Invalid or expired token' });
    }
    
    const user = result.rows[0];
    
    // Hash new password
    const passwordHash = await bcrypt.hash(newPassword, 10);
    
    await pool.query(
      'UPDATE users SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2',
      [passwordHash, user.id]
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ success: false, error: 'Failed to reset password' });
  }
});

// GET /api/user/vip-status
app.get('/api/user/vip-status', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const decoded = jwt.verify(token, JWT_SECRET);
    
    const result = await pool.query(
      'SELECT * FROM vip_access WHERE user_id = $1 AND expiry_date > NOW()',
      [decoded.userId.toString()]
    );
    
    if (result.rows.length > 0) {
      const vip = result.rows[0];
      res.json({
        isVIP: true,
        expiresAt: vip.expiry_date,
        subscriptionType: vip.product_id
      });
    } else {
      res.json({ isVIP: false });
    }
  } catch (error) {
    res.status(401).json({ isVIP: false });
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

