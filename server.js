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
const { calculateSmartRisk } = require('./backend/utils/riskCalculator');

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
const loginAttemptStore = new Map();
const forgotPasswordAttemptStore = new Map();

// Simple in-memory cache for live odds (5 minutes)
const oddsCache = new Map();

// Cleanup expired cache entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of oddsCache.entries()) {
    if (now - value.timestamp > 300000) { // 5 minutes = 300000ms
      oddsCache.delete(key);
    }
  }
}, 600000); // Check every 10 minutes

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

// Rate limiting middleware for login (brute force protection)
const rateLimitLogin = (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const windowMs = 15 * 60 * 1000; // 15 minutes
  const maxAttempts = 5;
  
  const attempts = loginAttemptStore.get(ip) || [];
  const recentAttempts = attempts.filter(time => now - time < windowMs);
  
  if (recentAttempts.length >= maxAttempts) {
    return res.status(429).json({ 
      success: false,
      error: 'Too many login attempts. Please try again in 15 minutes.' 
    });
  }
  
  // Cleanup old entries periodically
  if (Math.random() < 0.01) {
    for (const [key, times] of loginAttemptStore.entries()) {
      const filtered = times.filter(time => now - time < windowMs);
      if (filtered.length === 0) {
        loginAttemptStore.delete(key);
      } else {
        loginAttemptStore.set(key, filtered);
      }
    }
  }
  
  next();
};

// Rate limiting middleware for forgot-password (email bombing prevention)
const rateLimitForgotPassword = (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const windowMs = 15 * 60 * 1000; // 15 minutes
  const maxAttempts = 3; // Max 3 password reset requests per 15 min
  
  const attempts = forgotPasswordAttemptStore.get(ip) || [];
  const recentAttempts = attempts.filter(time => now - time < windowMs);
  
  if (recentAttempts.length >= maxAttempts) {
    return res.status(429).json({ 
      success: false,
      error: 'Too many password reset attempts. Please try again in 15 minutes.' 
    });
  }
  
  // Record this attempt
  recentAttempts.push(now);
  forgotPasswordAttemptStore.set(ip, recentAttempts);
  
  // Cleanup old entries periodically
  if (Math.random() < 0.01) {
    for (const [key, times] of forgotPasswordAttemptStore.entries()) {
      const filtered = times.filter(time => now - time < windowMs);
      if (filtered.length === 0) {
        forgotPasswordAttemptStore.delete(key);
      } else {
        forgotPasswordAttemptStore.set(key, filtered);
      }
    }
  }
  
  next();
};

// Rate limiting store for payment attempts
const paymentAttemptStore = new Map();

// Rate limiting middleware for payment endpoints (fraud prevention)
const rateLimitPayment = (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const windowMs = 15 * 60 * 1000; // 15 minutes
  const maxAttempts = 3; // Max 3 payment attempts per 15 min
  
  const attempts = paymentAttemptStore.get(ip) || [];
  const recentAttempts = attempts.filter(time => now - time < windowMs);
  
  if (recentAttempts.length >= maxAttempts) {
    return res.status(429).json({ 
      success: false,
      error: 'Too many payment attempts. Please try again in 15 minutes.' 
    });
  }
  
  // Record this attempt
  recentAttempts.push(now);
  paymentAttemptStore.set(ip, recentAttempts);
  
  // Cleanup old entries periodically
  if (Math.random() < 0.01) {
    for (const [key, times] of paymentAttemptStore.entries()) {
      const filtered = times.filter(time => now - time < windowMs);
      if (filtered.length === 0) {
        paymentAttemptStore.delete(key);
      } else {
        paymentAttemptStore.set(key, filtered);
      }
    }
  }
  
  next();
};

// JWT Authentication Middleware
const authenticateToken = async (req, res, next) => {
  try {
    // 1. Extract & validate authorization header
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        success: false,
        error: 'Authentication required' 
      });
    }
    
    // 2. Extract & trim token
    const token = authHeader.replace('Bearer ', '').trim();
    
    if (!token) {
      return res.status(401).json({ 
        success: false,
        error: 'No token provided' 
      });
    }
    
    // 3. Verify JWT token
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // 4. Validate token payload structure
    if (!decoded.userId) {
      return res.status(401).json({ 
        success: false,
        error: 'Invalid token payload' 
      });
    }
    
    // 5. Check if user still exists
    const userResult = await pool.query(
      'SELECT id, email, name FROM users WHERE id = $1',
      [decoded.userId]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(401).json({ 
        success: false,
        error: 'User not found' 
      });
    }
    
    // 6. Attach user to request object
    req.user = {
      id: userResult.rows[0].id,
      email: userResult.rows[0].email,
      name: userResult.rows[0].name
    };
    
    next();
    
  } catch (error) {
    // Production-safe error handling
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        success: false,
        error: 'Token expired' 
      });
    }
    
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ 
        success: false,
        error: 'Invalid token' 
      });
    }
    
    // Generic authentication error
    return res.status(401).json({ 
      success: false,
      error: 'Authentication failed' 
    });
  }
};

// ==========================================
// ADMIN AUTHENTICATION MIDDLEWARE
// ==========================================

// Admin list (in production, move to database)
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'admin@flashgoal.app').split(',').map(e => e.trim().toLowerCase());
const SUPER_ADMIN_EMAILS = (process.env.SUPER_ADMIN_EMAILS || 'superadmin@flashgoal.app').split(',').map(e => e.trim().toLowerCase());

// Require Admin Role
const requireAdmin = (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ 
        success: false, 
        error: 'Authentication required' 
      });
    }
    
    const userEmail = req.user.email.toLowerCase();
    
    if (!ADMIN_EMAILS.includes(userEmail) && !SUPER_ADMIN_EMAILS.includes(userEmail)) {
      return res.status(403).json({ 
        success: false, 
        error: 'Admin access required' 
      });
    }
    
    req.isAdmin = true;
    req.isSuperAdmin = SUPER_ADMIN_EMAILS.includes(userEmail);
    next();
  } catch (error) {
    return res.status(403).json({ 
      success: false, 
      error: 'Admin verification failed' 
    });
  }
};

// Require Super Admin Role (for destructive operations)
const requireSuperAdmin = (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ 
        success: false, 
        error: 'Authentication required' 
      });
    }
    
    const userEmail = req.user.email.toLowerCase();
    
    if (!SUPER_ADMIN_EMAILS.includes(userEmail)) {
      return res.status(403).json({ 
        success: false, 
        error: 'Super admin access required' 
      });
    }
    
    req.isSuperAdmin = true;
    next();
  } catch (error) {
    return res.status(403).json({ 
      success: false, 
      error: 'Super admin verification failed' 
    });
  }
};

// Cron Job Authentication (secret token)
const authenticateCron = (req, res, next) => {
  const cronToken = req.headers['x-cron-token'] || req.query.token;
  const validToken = process.env.CRON_SECRET_TOKEN || 'change-this-in-production';
  
  if (!cronToken || cronToken !== validToken) {
    return res.status(401).json({ 
      success: false, 
      error: 'Invalid cron token' 
    });
  }
  
  next();
};

// Rate limiting for admin operations
const rateLimitAdminOps = new Map();

const rateLimitAdmin = (maxAttempts, windowMs) => {
  return (req, res, next) => {
    const key = `${req.user?.id || req.ip}-${req.path}`;
    const now = Date.now();
    
    const attempts = rateLimitAdminOps.get(key) || [];
    const recentAttempts = attempts.filter(time => now - time < windowMs);
    
    if (recentAttempts.length >= maxAttempts) {
      return res.status(429).json({ 
        success: false,
        error: `Too many requests. Please wait ${Math.ceil(windowMs / 60000)} minutes.` 
      });
    }
    
    recentAttempts.push(now);
    rateLimitAdminOps.set(key, recentAttempts);
    
    // Cleanup
    if (Math.random() < 0.01) {
      for (const [k, times] of rateLimitAdminOps.entries()) {
        const filtered = times.filter(time => now - time < windowMs);
        if (filtered.length === 0) {
          rateLimitAdminOps.delete(k);
        } else {
          rateLimitAdminOps.set(k, filtered);
        }
      }
    }
    
    next();
  };
};

// ==========================================
// HELPER FUNCTIONS
// ==========================================

// Enrich predictions with colors and flags (fixes N+1 problem with caching)
const colorCache = new Map();
async function enrichPredictions(predictions) {
  for (const pred of predictions) {
    // Use cache for colors to reduce API calls
    const homeKey = `${pred.home_team}-${pred.home_logo}`;
    const awayKey = `${pred.away_team}-${pred.away_logo}`;
    
    if (!colorCache.has(homeKey)) {
      colorCache.set(homeKey, await getTeamColors(pred.home_team, pred.home_logo));
    }
    if (!colorCache.has(awayKey)) {
      colorCache.set(awayKey, await getTeamColors(pred.away_team, pred.away_logo));
    }
    
    pred.home_colors = colorCache.get(homeKey);
    pred.away_colors = colorCache.get(awayKey);
    
    // Fix league flag
    if (!pred.league_flag || pred.league_flag === '🌍') {
      pred.league_flag = getLeagueFlag(pred.league);
    }
  }
  return predictions;
}

// Clear color cache periodically (every 1 hour)
setInterval(() => {
  colorCache.clear();
}, 3600000);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// JWT SECRET
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('❌ FATAL ERROR: JWT_SECRET environment variable is not set!');
  console.error('Please set JWT_SECRET in your .env file or environment variables.');
  process.exit(1);
}

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
  'scotland': '🏴󠁧󠁢󠁳󠁣󠁴󠁿',
  'iskocya': '🏴󠁧󠁢󠁳󠁣󠁴󠁿',
  'scottish': '🏴󠁧󠁢󠁳󠁣󠁴󠁿',
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
  'chilean': '🇨🇱',
  'liechtenstein': '🇱🇮',
  'kyrgyzstan': '🇰🇬',
  'congo': '🇨🇬',
  'dr congo': '🇨🇩',
  'democratic republic of the congo': '🇨🇩',
  'northern ireland': '🇬🇧',
  'wales': '🏴󠁧󠁢󠁷󠁬󠁳󠁿',
  'albania': '🇦🇱',
  'arnavutluk': '🇦🇱',
  'albanian': '🇦🇱',
  'estonia': '🇪🇪',
  'estonya': '🇪🇪',
  'estonian': '🇪🇪',
  'georgia': '🇬🇪',
  'gürcistan': '🇬🇪',
  'gurcistan': '🇬🇪',
  'georgian': '🇬🇪',
  'ivory coast': '🇨🇮',
  "cote d'ivoire": '🇨🇮',
  'fildisi sahilleri': '🇨🇮',
  'luxembourg': '🇱🇺',
  'lüksemburg': '🇱🇺',
  'luksemburg': '🇱🇺',
  'luxembourgish': '🇱🇺',
  'mongolia': '🇲🇳',
  'moğolistan': '🇲🇳',
  'mogolistan': '🇲🇳',
  'mongolian': '🇲🇳'
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
    
    // ==========================================
    // RISK BADGE SYSTEM - Database Migration
    // ==========================================
    try {
      // Add risk badge columns to predictions table
      await pool.query(`
        ALTER TABLE predictions 
        ADD COLUMN IF NOT EXISTS filter_name VARCHAR(50)
      `);
      await pool.query(`
        ALTER TABLE predictions 
        ADD COLUMN IF NOT EXISTS risk_badge VARCHAR(20)
      `);
      await pool.query(`
        ALTER TABLE predictions 
        ADD COLUMN IF NOT EXISTS risk_score INTEGER
      `);
      await pool.query(`
        ALTER TABLE predictions 
        ADD COLUMN IF NOT EXISTS risk_color VARCHAR(10)
      `);
      await pool.query(`
        ALTER TABLE predictions 
        ADD COLUMN IF NOT EXISTS risk_emoji VARCHAR(10)
      `);
      await pool.query(`
        ALTER TABLE predictions 
        ADD COLUMN IF NOT EXISTS success_rate INTEGER
      `);
      await pool.query(`
        ALTER TABLE predictions 
        ADD COLUMN IF NOT EXISTS expected_value DECIMAL(4,2)
      `);
      await pool.query(`
        ALTER TABLE predictions 
        ADD COLUMN IF NOT EXISTS description_tr TEXT
      `);
      await pool.query(`
        ALTER TABLE predictions 
        ADD COLUMN IF NOT EXISTS estimated_time VARCHAR(20)
      `);
      await pool.query(`
        ALTER TABLE predictions 
        ADD COLUMN IF NOT EXISTS auto_calculated BOOLEAN DEFAULT true
      `);
      console.log('✅ Risk badge columns added to predictions table');
    } catch (error) {
      if (!error.message.includes('already exists') && !error.message.includes('duplicate')) {
        console.log('ℹ️ Risk badge columns check:', error.message);
      }
    }
    
    // Create indexes for risk badge system
    try {
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_predictions_filter ON predictions(filter_name)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_predictions_risk ON predictions(risk_badge)`);
      console.log('✅ Risk badge indexes created');
    } catch (error) {
      if (!error.message.includes('already exists')) {
        console.log('ℹ️ Risk badge indexes check:', error.message);
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
    
    // ==========================================
    // PAYMENT ATTEMPTS TABLE - Security & Audit Trail
    // ==========================================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS payment_attempts (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL,
        product_id VARCHAR(50) NOT NULL,
        amount INT NOT NULL,
        currency VARCHAR(3) DEFAULT 'try',
        stripe_session_id VARCHAR(255) UNIQUE,
        status VARCHAR(20) DEFAULT 'initiated',
        ip_address VARCHAR(45),
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_payment_user ON payment_attempts(user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_payment_session ON payment_attempts(stripe_session_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_payment_status ON payment_attempts(status)`);
    console.log('✅ Payment attempts table ready');
    
  } catch (error) {
    console.error('❌ DB error:', error);
  }
}

initDatabase();

// ==========================================
// POST /api/cleanup (ADMIN ONLY - SECURE)
// Delete old predictions (older than 2 days)
// ==========================================
app.post('/api/cleanup', 
  authenticateToken,
  requireAdmin,
  rateLimitAdmin(5, 24 * 60 * 60 * 1000), // 5 per day
  async (req, res) => {
    try {
      // Delete predictions older than 2 days
      const result = await pool.query(
        `DELETE FROM predictions 
         WHERE created_at < NOW() - INTERVAL '2 days' 
         RETURNING id`
      );
      
      // Production-safe logging
      if (process.env.NODE_ENV !== 'production') {
        console.log(`Cleanup: Deleted ${result.rowCount} predictions by ${req.user.email}`);
      }
      
      res.json({ 
        success: true, 
        message: `Deleted ${result.rowCount} old predictions`,
        count: result.rowCount 
      });
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('Cleanup error:', error);
      }
      
      res.status(500).json({ 
        success: false, 
        error: 'Cleanup operation failed' 
      });
    }
  }
);

// ==========================================
// DELETE /api/predictions/all (SUPER ADMIN ONLY - EXTREMELY DANGEROUS)
// Delete ALL predictions - requires confirmation
// ==========================================
app.delete('/api/predictions/all', 
  authenticateToken,
  requireSuperAdmin,
  rateLimitAdmin(1, 60 * 60 * 1000), // 1 per hour
  async (req, res) => {
    try {
      // Require explicit confirmation
      const { confirm } = req.body;
      
      if (confirm !== true && confirm !== 'true') {
        return res.status(400).json({ 
          success: false, 
          error: 'Confirmation required. Send { "confirm": true } to proceed.' 
        });
      }
      
      // Get count before deletion (for audit)
      const countResult = await pool.query('SELECT COUNT(*) FROM predictions');
      const totalCount = parseInt(countResult.rows[0].count);
      
      // Delete ALL predictions
      const result = await pool.query('DELETE FROM predictions RETURNING id');
      
      // Production-safe logging (CRITICAL operation)
      if (process.env.NODE_ENV !== 'production') {
        console.log(`⚠️ CRITICAL: ALL PREDICTIONS DELETED (${result.rowCount}) by ${req.user.email}`);
      }
      
      res.json({ 
        success: true, 
        message: `Deleted all ${result.rowCount} predictions`,
        count: result.rowCount,
        warning: 'This operation cannot be undone'
      });
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('Delete all error:', error);
      }
      
      res.status(500).json({ 
        success: false, 
        error: 'Delete operation failed' 
      });
    }
  }
);

// ==========================================
// GET /api/matches/live (PUBLIC)
// Get live matches from Football API
// ==========================================
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
    if (process.env.NODE_ENV !== 'production') {
      console.error('Live matches error:', error.message);
    }
    res.status(500).json({ success: false, error: 'Failed to fetch live matches' });
  }
});

// ==========================================
// GET /api/matches/:id (PUBLIC)
// Get specific match data from Football API
// ==========================================
app.get('/api/matches/:id', async (req, res) => {
  const matchId = req.params.id;
  
  // Validate ID
  const matchIdNum = parseInt(matchId);
  if (isNaN(matchIdNum) || matchIdNum <= 0) {
    return res.status(400).json({ error: 'Invalid match ID' });
  }
  
  try {
    const response = await axios.get(
      `https://v3.football.api-sports.io/fixtures`,
      {
        params: { id: matchIdNum },
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
    if (process.env.NODE_ENV !== 'production') {
      console.error('Error fetching match:', error);
    }
    res.status(500).json({ error: 'Failed to fetch match data' });
  }
});

// ==========================================
// POST /api/matches/batch (PUBLIC - RATE LIMITED)
// Get multiple matches in one request (optimized)
// ==========================================
app.post('/api/matches/batch', rateLimitBatch, async (req, res) => {
  const { matchIds } = req.body;
  
  // Input validation
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
    
    // Format match data
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
    if (process.env.NODE_ENV !== 'production') {
      console.error('Error fetching batch matches:', error.message);
    }
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

// ==========================================
// GET /api/predictions/active (PUBLIC - OPTIMIZED)
// Get active predictions with pagination
// ==========================================
app.get('/api/predictions/active', async (req, res) => {
  try {
    // Pagination
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    
    // Get total count
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM predictions WHERE status = $1',
      ['active']
    );
    const total = parseInt(countResult.rows[0].count);
    
    // Get predictions with specific columns only
    const result = await pool.query(
      `SELECT id, match_id, home_team, away_team, league, 
              prediction_type, status, odds, confidence, 
              home_logo, away_logo, league_flag, league_logo,
              home_score, away_score, is_urgent, 
              created_at, updated_at
       FROM predictions 
       WHERE status = $1 
       ORDER BY created_at DESC 
       LIMIT $2 OFFSET $3`,
      ['active', limit, offset]
    );
    
    // Enrich with colors and flags (uses caching - N+1 fix)
    const predictions = await enrichPredictions(result.rows);
    
    // Response with pagination metadata
    res.json({ 
      success: true, 
      predictions: predictions,
      pagination: {
        total: total,
        limit: limit,
        offset: offset,
        count: predictions.length,
        hasMore: offset + limit < total,
        page: Math.floor(offset / limit) + 1,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('Get active predictions error:', error);
    }
    
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch active predictions' 
    });
  }
});

// ==========================================
// GET /api/predictions/completed (PUBLIC - OPTIMIZED)
// Get completed predictions with pagination
// ==========================================
app.get('/api/predictions/completed', async (req, res) => {
  try {
    // Pagination
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    
    // Get total count
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM predictions WHERE status = $1',
      ['completed']
    );
    const total = parseInt(countResult.rows[0].count);
    
    // Get predictions with specific columns
    const result = await pool.query(
      `SELECT id, match_id, home_team, away_team, league, 
              prediction_type, status, result, odds, confidence, 
              home_logo, away_logo, league_flag, league_logo,
              home_score, away_score, is_urgent, 
              created_at, updated_at, completed_at
       FROM predictions 
       WHERE status = $1 
       ORDER BY completed_at DESC NULLS LAST, created_at DESC 
       LIMIT $2 OFFSET $3`,
      ['completed', limit, offset]
    );
    
    // Enrich with colors and flags (uses caching - N+1 fix)
    const predictions = await enrichPredictions(result.rows);
    
    // Response with pagination metadata
    res.json({ 
      success: true, 
      predictions: predictions,
      pagination: {
        total: total,
        limit: limit,
        offset: offset,
        count: predictions.length,
        hasMore: offset + limit < total,
        page: Math.floor(offset / limit) + 1,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('Get completed predictions error:', error);
    }
    
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch completed predictions' 
    });
  }
});

// ==========================================
// GET /api/test/completed-predictions (TEST ONLY - DISABLED IN PRODUCTION)
// Test endpoint - check completed predictions with scores
// ==========================================
app.get('/api/test/completed-predictions', 
  (req, res, next) => {
    // Disable in production
    if (process.env.NODE_ENV === 'production') {
      return res.status(404).json({ 
        success: false, 
        error: 'Test endpoint not available in production' 
      });
    }
    next();
  },
  async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, home_team, away_team, home_score, away_score, 
                status, result, completed_at, prediction_type, match_id
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
          withScores: result.rows.filter(p => p.home_score !== null && p.away_score !== null).length,
          withoutScores: result.rows.filter(p => p.home_score === null || p.away_score === null).length,
          zeroScores: result.rows.filter(p => p.home_score === 0 && p.away_score === 0).length
        }
      });
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('Test query error:', error);
      }
      
      res.status(500).json({ 
        success: false, 
        error: 'Test query failed' 
      });
    }
  }
);

app.post('/api/predictions', async (req, res) => {
  try {
    const { match_id, home_team, away_team, league, prediction_type, odds, confidence, home_logo, away_logo, league_flag, league_logo, home_score, away_score, is_urgent, filterName } = req.body;

    if (!match_id || !home_team || !away_team || !prediction_type) {
      return res.status(400).json({ success: false, error: 'Missing fields' });
    }

    const oddsValue = odds && !isNaN(parseFloat(odds)) ? parseFloat(odds) : 0;
    const isUrgentValue = is_urgent === true || is_urgent === 'true';

    // Calculate smart risk badge
    const riskData = calculateSmartRisk(filterName, oddsValue);

    const result = await pool.query(
      `INSERT INTO predictions 
       (match_id, home_team, away_team, league, prediction_type, odds, confidence, status, home_logo, away_logo, league_flag, league_logo, home_score, away_score, is_urgent, filter_name, risk_badge, risk_score, risk_color, risk_emoji, success_rate, expected_value, description_tr, estimated_time, auto_calculated) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24) 
       RETURNING *`,
      [
        match_id, 
        home_team, 
        away_team, 
        league, 
        prediction_type, 
        oddsValue, 
        confidence || 'orta', 
        home_logo || null, 
        away_logo || null, 
        league_flag || null, 
        league_logo || null, 
        home_score || 0, 
        away_score || 0, 
        isUrgentValue,
        riskData.filter_name,
        riskData.risk_badge,
        riskData.risk_score,
        riskData.risk_color,
        riskData.risk_emoji,
        riskData.success_rate,
        riskData.expected_value,
        riskData.description_tr,
        riskData.estimated_time,
        riskData.auto_calculated
      ]
    );

    const prediction = result.rows[0];
    
    // Get team colors - try database first, then logo extraction
    const homeColors = await getTeamColors(home_team, home_logo);
    const awayColors = await getTeamColors(away_team, away_logo);
    
    // Add colors to prediction object
    prediction.home_colors = homeColors;
    prediction.away_colors = awayColors;

    res.status(201).json({ 
      success: true, 
      prediction: prediction,
      risk: {
        badge: riskData.risk_badge,
        score: riskData.risk_score,
        color: riskData.risk_color,
        emoji: riskData.risk_emoji,
        success_rate: riskData.success_rate,
        expected_value: riskData.expected_value,
        description_tr: riskData.description_tr,
        estimated_time: riskData.estimated_time
      }
    });
  } catch (error) {
    console.error('❌ Create:', error);
    res.status(500).json({ success: false, error: 'Failed' });
  }
});

// ==========================================
// GET /api/admin/live-odds/:fixtureId (ADMIN ONLY)
// Get live odds from API-Football (only goal-related odds)
// ==========================================
app.get('/api/admin/live-odds/:fixtureId',
  authenticateToken,
  requireAdmin,
  rateLimitAdmin(30, 60 * 1000), // 30 per minute
  async (req, res) => {
    try {
      const { fixtureId } = req.params;
      
      // Validate fixture ID
      const fixtureIdNum = parseInt(fixtureId);
      if (isNaN(fixtureIdNum) || fixtureIdNum <= 0) {
        return res.status(400).json({ 
          success: false, 
          error: 'Invalid fixture ID' 
        });
      }
      
      // Cache kontrolü (5 dakika)
      const cacheKey = `live_odds_${fixtureIdNum}`;
      const cached = oddsCache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp) < 300000) {
        return res.json({ 
          success: true, 
          odds: cached.data,
          bookmaker: cached.bookmaker,
          lastUpdate: cached.lastUpdate,
          cached: true
        });
      }
      
      // API-Football Live Odds
      const response = await axios.get(
        'https://v3.football.api-sports.io/odds/live',
        {
          params: { fixture: fixtureIdNum },
          headers: {
            'x-apisports-key': process.env.FOOTBALL_API_KEY,
            'x-rapidapi-host': 'v3.football.api-sports.io'
          },
          timeout: 10000
        }
      );
      
      const data = response.data;
      
      if (!data.response || data.response.length === 0) {
        return res.json({ 
          success: false, 
          message: 'Bu maç için canlı oran bulunamadı' 
        });
      }
      
      // Bet365 oranlarını tercih et
      const bet365Data = data.response.find(
        (bookmaker) => bookmaker.bookmaker && bookmaker.bookmaker.name === 'Bet365'
      );
      
      const bookmakerData = bet365Data || data.response[0];
      
      if (!bookmakerData || !bookmakerData.bets) {
        return res.json({ 
          success: false, 
          message: 'Bu maç için bahis verisi bulunamadı' 
        });
      }
      
      // SADECE GOL ORANLARI parse et
      const parsedOdds = {
        btts: null,  // Karşılıklı Gol
        overUnder: {},  // 0.5'ten 9.5'e kadar
        homeGoals: {},  // Ev sahibi gol oranları
        awayGoals: {},  // Deplasman gol oranları
      };
      
      bookmakerData.bets.forEach((bet) => {
        if (!bet || !bet.name || !bet.values) return;
        
        // BTTS (Karşılıklı Gol)
        if (bet.name === 'Both Teams Score') {
          const yesValue = bet.values.find(v => v.value === 'Yes');
          const noValue = bet.values.find(v => v.value === 'No');
          parsedOdds.btts = {
            yes: yesValue ? parseFloat(yesValue.odd) : null,
            no: noValue ? parseFloat(noValue.odd) : null,
          };
        }
        
        // Goals Over/Under (0.5 - 9.5)
        if (bet.name === 'Goals Over/Under') {
          bet.values.forEach((v) => {
            if (!v.value || !v.odd) return;
            const match = v.value.match(/(Over|Under)\s+([\d.]+)/);
            if (match) {
              const type = match[1].toLowerCase();  // 'over' veya 'under'
              const total = match[2];  // '0.5', '1.5', '2.5', vs.
              
              if (!parsedOdds.overUnder[total]) {
                parsedOdds.overUnder[total] = {};
              }
              parsedOdds.overUnder[total][type] = parseFloat(v.odd);
            }
          });
        }
        
        // Home Team Goals (Ev sahibi gol)
        if (bet.name === 'Home Team Goals' || bet.name === 'Home Over/Under') {
          bet.values.forEach((v) => {
            if (!v.value || !v.odd) return;
            const match = v.value.match(/(Over|Under)\s+([\d.]+)/);
            if (match) {
              const type = match[1].toLowerCase();
              const total = match[2];
              
              if (!parsedOdds.homeGoals[total]) {
                parsedOdds.homeGoals[total] = {};
              }
              parsedOdds.homeGoals[total][type] = parseFloat(v.odd);
            }
          });
        }
        
        // Away Team Goals (Deplasman gol)
        if (bet.name === 'Away Team Goals' || bet.name === 'Away Over/Under') {
          bet.values.forEach((v) => {
            if (!v.value || !v.odd) return;
            const match = v.value.match(/(Over|Under)\s+([\d.]+)/);
            if (match) {
              const type = match[1].toLowerCase();
              const total = match[2];
              
              if (!parsedOdds.awayGoals[total]) {
                parsedOdds.awayGoals[total] = {};
              }
              parsedOdds.awayGoals[total][type] = parseFloat(v.odd);
            }
          });
        }
      });
      
      const bookmakerName = bookmakerData.bookmaker ? bookmakerData.bookmaker.name : 'Unknown';
      const lastUpdate = new Date().toISOString();
      
      // 5 dakika cache
      oddsCache.set(cacheKey, {
        data: parsedOdds,
        bookmaker: bookmakerName,
        lastUpdate: lastUpdate,
        timestamp: Date.now()
      });
      
      res.json({ 
        success: true, 
        odds: parsedOdds,
        bookmaker: bookmakerName,
        lastUpdate: lastUpdate,
        cached: false
      });
      
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('Live odds error:', error.message);
      }
      res.status(500).json({ 
        success: false, 
        error: 'Canlı oranlar alınamadı' 
      });
    }
  }
);

// ==========================================
// PUT /api/predictions/:id/result (ADMIN ONLY - SECURE)
// Update prediction result (won/lost/void)
// ==========================================
app.put('/api/predictions/:id/result', 
  authenticateToken,
  requireAdmin,
  rateLimitAdmin(20, 60 * 1000), // 20 per minute
  async (req, res) => {
    try {
      const { id } = req.params;
      const { result } = req.body;
      
      // Validate ID is integer
      const predictionId = parseInt(id);
      if (isNaN(predictionId) || predictionId <= 0) {
        return res.status(400).json({ 
          success: false, 
          error: 'Invalid prediction ID' 
        });
      }
      
      // Validate result enum
      const validResults = ['won', 'lost', 'void'];
      if (!result || !validResults.includes(result)) {
        return res.status(400).json({ 
          success: false, 
          error: `Result must be one of: ${validResults.join(', ')}` 
        });
      }
      
      // Check prediction exists
      const existingCheck = await pool.query(
        'SELECT id, status, result FROM predictions WHERE id = $1',
        [predictionId]
      );
      
      if (existingCheck.rows.length === 0) {
        return res.status(404).json({ 
          success: false, 
          error: 'Prediction not found' 
        });
      }
      
      // Check if already has a result
      const existing = existingCheck.rows[0];
      if (existing.result && existing.result !== null) {
        return res.status(409).json({ 
          success: false, 
          error: `Prediction already has result: ${existing.result}. Cannot modify.`,
          currentResult: existing.result
        });
      }
      
      // Update prediction
      await pool.query(
        'UPDATE predictions SET status = $1, result = $2, completed_at = NOW(), updated_at = NOW() WHERE id = $3',
        ['completed', result, predictionId]
      );
      
      res.json({ 
        success: true,
        message: 'Prediction result updated',
        predictionId: predictionId,
        result: result
      });
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('Update result error:', error);
      }
      
      res.status(500).json({ 
        success: false, 
        error: 'Failed to update prediction result' 
      });
    }
  }
);

// ==========================================
// DELETE /api/predictions/:id (ADMIN ONLY - SOFT DELETE)
// Soft delete prediction (marks as deleted instead of removing)
// ==========================================
app.delete('/api/predictions/:id', 
  authenticateToken,
  requireAdmin,
  rateLimitAdmin(10, 60 * 1000), // 10 per minute
  async (req, res) => {
    try {
      const { id } = req.params;
      
      // Validate ID
      const predictionId = parseInt(id);
      if (isNaN(predictionId) || predictionId <= 0) {
        return res.status(400).json({ 
          success: false, 
          error: 'Invalid prediction ID' 
        });
      }
      
      // Check if prediction exists
      const existingCheck = await pool.query(
        'SELECT id FROM predictions WHERE id = $1',
        [predictionId]
      );
      
      if (existingCheck.rows.length === 0) {
        return res.status(404).json({ 
          success: false, 
          error: 'Prediction not found' 
        });
      }
      
      // Soft delete (mark as cancelled instead of removing)
      await pool.query(
        'UPDATE predictions SET status = $1, updated_at = NOW() WHERE id = $2',
        ['cancelled', predictionId]
      );
      
      res.json({ 
        success: true,
        message: 'Prediction marked as cancelled',
        predictionId: predictionId
      });
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('Delete prediction error:', error);
      }
      
      res.status(500).json({ 
        success: false, 
        error: 'Failed to delete prediction' 
      });
    }
  }
);

// ==========================================
// GET /api/cron/update-scores (CRON ONLY - SECURE)
// Update prediction scores from Football API
// ==========================================
app.get('/api/cron/update-scores', 
  authenticateCron,
  rateLimitAdmin(10, 60 * 1000), // 10 per minute
  async (req, res) => {
    try {
      if (process.env.NODE_ENV !== 'production') {
        console.log('[CRON] Checking predictions...');
      }
      
      // Get active and completed predictions
      const predictions = await pool.query(
        'SELECT * FROM predictions WHERE status IN ($1, $2)',
        ['active', 'completed']
      );

      if (process.env.NODE_ENV !== 'production') {
        console.log(`Found ${predictions.rows.length} predictions to check`);
      }
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
          if (process.env.NODE_ENV !== 'production') {
            console.log(`No fixture found for match_id: ${pred.match_id}`);
          }
          continue;
        }
        
        const statusShort = fixture.fixture.status.short;
        const homeGoals = fixture.goals.home ?? null;
        const awayGoals = fixture.goals.away ?? null;
        
        // API'den skor gelmiyorsa logla
        if (homeGoals === null || awayGoals === null) {
          if (process.env.NODE_ENV !== 'production') {
            console.log(`Match ${pred.match_id} - Goals are null: home=${homeGoals}, away=${awayGoals}, status=${statusShort}`);
          }
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
          // İY tahminleri - 1H'da da kontrol et
          if (predType.includes("İY") || predType.includes("IY")) {
            // 1H ise canlı skora bak (erken kazanma)
            if (statusShort === "1H") {
              const currentTotal = homeScore + awayScore;
              if (predType.includes("0.5Ü") && currentTotal > 0.5) result = "won";
              else if (predType.includes("1.5Ü") && currentTotal > 1.5) result = "won";
              else if (predType.includes("2.5Ü") && currentTotal > 2.5) result = "won";
              
              if (result === "won") {
                shouldUpdateResult = true;
                shouldUpdateScore = true;
              }
            }
            // HT/2H ise halftime skoruna bak (final sonuç)
            else if (statusShort === "HT" || statusShort === "2H") {
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
          if (process.env.NODE_ENV !== 'production') {
            console.log(`Updated scores for #${pred.id}: ${homeScore}-${awayScore}`);
          }
        }
        
        // Skor + result güncelleme
        if (shouldUpdateScore && shouldUpdateResult && result) {
          await pool.query(
            'UPDATE predictions SET home_score = $1, away_score = $2, status = $3, result = $4, completed_at = NOW(), updated_at = NOW() WHERE id = $5',
            [homeScore, awayScore, 'completed', result, pred.id]
          );
          updated++;
          if (process.env.NODE_ENV !== 'production') {
            console.log(`Completed #${pred.id}: ${result.toUpperCase()} (${homeScore}-${awayScore})`);
          }
        }
      } catch (err) {
        if (process.env.NODE_ENV !== 'production') {
          console.error(`Error updating prediction #${pred.id}:`, err.message);
        }
      }
    }

      if (process.env.NODE_ENV !== 'production') {
        console.log(`Cron completed: ${updated} predictions completed, ${scoreUpdated} scores updated`);
      }
      
      res.json({ success: true, updated, scoreUpdated, total: predictions.rows.length });
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('Update scores error:', error);
      }
      
      res.status(500).json({ 
        success: false, 
        error: 'Failed to update scores' 
      });
    }
  }
);

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

// Gece 00:00 Türkiye saati = 21:00 UTC
cron.schedule("0 21 * * *", async () => {
  try {
    // Son 10 completed tahmin KAL, geri kalanı SİL
    const result = await pool.query(`
      DELETE FROM predictions 
      WHERE id NOT IN (
        SELECT id FROM predictions 
        WHERE status = 'completed'
        ORDER BY completed_at DESC NULLS LAST
        LIMIT 10
      )
      AND status = 'completed'
      RETURNING id
    `);
    console.log(`🗑️ Cleanup: Deleted ${result.rowCount} old completed predictions (kept last 10)`);
  } catch (error) {
    console.error("❌ Cleanup error:", error.message);
  }
});

cron.schedule("*/30 * * * * *", async () => {
  try {
    const { rows } = await pool.query("SELECT * FROM predictions WHERE status IN ('active', 'completed')");
    
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
        
        // İY (İlk Yarı) tahminleri - 1H'da CANLI kontrol, HT'de FINAL kontrol
        if (predType.includes("İY") || predType.includes("IY")) {
          const is1H = statusShort === "1H";
          
          // Sadece active tahminler için result belirle
          if (pred.status === 'active') {
            // 1H ise canlı skora bak (erken kazanma)
            if (is1H) {
              const currentTotal = homeScore + awayScore;
              if (predType.includes("0.5Ü") && currentTotal > 0.5) {
                result = "won";
                shouldUpdate = true;
              }
              else if (predType.includes("1.5Ü") && currentTotal > 1.5) {
                result = "won";
                shouldUpdate = true;
              }
              else if (predType.includes("2.5Ü") && currentTotal > 2.5) {
                result = "won";
                shouldUpdate = true;
              }
            }
            // HT/2H/FT ise halftime skoruna bak (final sonuç)
            else if (isHT) {
              if (predType.includes("0.5Ü")) result = htTotal > 0.5 ? "won" : "lost";
              else if (predType.includes("1.5Ü")) result = htTotal > 1.5 ? "won" : "lost";
              else if (predType.includes("2.5Ü")) result = htTotal > 2.5 ? "won" : "lost";
              shouldUpdate = true;
            }
          }
        } 
        // MB (Maç Boyu) tahminleri - Canlı maçta erken kazanma kontrolü
        else if (predType.includes("MB")) {
          const isLive = ["1H", "2H", "HT", "FT", "AET", "PEN"].includes(statusShort);
          
          // Sadece active tahminler için result belirle
          if (pred.status === 'active') {
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
        }
        
        // Completed tahminlerin skorlarını güncelle (result değişmez)
        if (pred.status === 'completed' && (pred.home_score !== homeScore || pred.away_score !== awayScore)) {
          await pool.query(
            "UPDATE predictions SET home_score = $1, away_score = $2, updated_at = NOW() WHERE id = $3",
            [homeScore, awayScore, pred.id]
          );
          console.log(`📊 #${pred.id}: Score updated ${homeScore}-${awayScore} (already completed)`);
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

// ==========================================
// GET /api/user/referral-info (USER ONLY - SECURE)
// Get referral info for authenticated user
// ==========================================
app.get('/api/user/referral-info', 
  authenticateToken,
  async (req, res) => {
    try {
      // Get userId from token (NOT from client)
      const userId = req.user.id;
      
      const result = await pool.query(
        'SELECT referral_code, referral_count, vip_bonus_days, referred_by FROM users WHERE id = $1',
        [userId]
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({ 
          success: false, 
          error: 'User not found' 
        });
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
      if (process.env.NODE_ENV !== 'production') {
        console.error('Get referral info error:', error);
      }
      
      res.status(500).json({ 
        success: false, 
        error: 'Failed to get referral info' 
      });
    }
  }
);

// ==========================================
// POST /api/referral/validate (PUBLIC - RATE LIMITED)
// Validate referral code
// ==========================================
app.post('/api/referral/validate', 
  rateLimitPayment, // Reuse existing rate limiter (3 per 15 min)
  async (req, res) => {
    try {
      const { referral_code } = req.body;
      
      // Input validation
      if (!referral_code) {
        return res.status(400).json({ 
          success: false, 
          valid: false, 
          message: 'Referral code is required' 
        });
      }
      
      // Code format validation (alphanumeric, 6-20 chars)
      if (!/^[A-Z0-9]{6,20}$/i.test(referral_code)) {
        return res.json({ 
          success: true, 
          valid: false, 
          message: 'Invalid referral code format' 
        });
      }
      
      // XSS protection (sanitize)
      const sanitizedCode = referral_code.toUpperCase().trim();
      
      // Check if referral code exists
      const result = await pool.query(
        'SELECT id, referral_count FROM users WHERE referral_code = $1',
        [sanitizedCode]
      );
      
      if (result.rows.length === 0) {
        return res.json({ 
          success: true, 
          valid: false, 
          message: 'Invalid referral code' 
        });
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
      
      res.json({ 
        success: true, 
        valid: true, 
        message: 'Referral code is valid' 
      });
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('Validate referral error:', error);
      }
      
      res.status(500).json({ 
        success: false, 
        valid: false, 
        message: 'Failed to validate referral code' 
      });
    }
  }
);

// ==========================================
// GET /api/referral/history (USER ONLY - SECURE)
// Get referral history for authenticated user with pagination
// ==========================================
app.get('/api/referral/history', 
  authenticateToken,
  async (req, res) => {
    try {
      // Get userId from token (NOT from client)
      const userId = req.user.id;
      
      // Pagination
      const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
      const offset = Math.max(parseInt(req.query.offset) || 0, 0);
      
      // Get total count
      const countResult = await pool.query(
        'SELECT COUNT(*) FROM referrals WHERE referrer_user_id = $1',
        [userId]
      );
      const total = parseInt(countResult.rows[0].count);
      
      // Get referral history
      const result = await pool.query(
        `SELECT referred_email, created_at, bonus_given 
         FROM referrals 
         WHERE referrer_user_id = $1 
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      );
      
      res.json({
        success: true,
        referrals: result.rows.map(row => ({
          referred_email: row.referred_email,
          created_at: row.created_at,
          bonus_given: row.bonus_given
        })),
        pagination: {
          total: total,
          limit: limit,
          offset: offset,
          count: result.rows.length,
          hasMore: offset + limit < total
        }
      });
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('Get referral history error:', error);
      }
      
      res.status(500).json({ 
        success: false, 
        error: 'Failed to get referral history' 
      });
    }
  }
);

// ==========================================
// REVENUECAT WEBHOOK
// ==========================================

// ==========================================
// POST /api/webhook/revenuecat (WEBHOOK - SECURE)
// RevenueCat webhook handler with signature verification
// Handles 24h consumable purchases and subscription events
// ==========================================
app.post("/api/webhook/revenuecat", async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  
  try {
    // ========================================
    // 1. VERIFY WEBHOOK SIGNATURE
    // ========================================
    const authHeader = req.headers.authorization;
    const webhookToken = process.env.REVENUECAT_WEBHOOK_TOKEN;
    
    // Verify authorization header if token is configured
    if (webhookToken) {
      if (!authHeader) {
        console.error('❌ [RevenueCat Webhook] Missing authorization header');
        return res.status(401).json({ 
          success: false,
          error: 'Unauthorized: Missing authorization header' 
        });
      }
      
      // RevenueCat sends: Bearer <webhook_token>
      const token = authHeader.replace('Bearer ', '').trim();
      
      if (token !== webhookToken) {
        console.error('❌ [RevenueCat Webhook] Invalid webhook token');
        return res.status(401).json({ 
          success: false,
          error: 'Unauthorized: Invalid webhook token' 
        });
      }
      
      console.log('✅ [RevenueCat Webhook] Signature verified');
    } else {
      console.warn('⚠️  [RevenueCat Webhook] REVENUECAT_WEBHOOK_TOKEN not set - skipping verification');
    }
    
    // ========================================
    // 2. PARSE WEBHOOK PAYLOAD
    // ========================================
    const event = req.body;
    
    // Validate webhook payload structure
    if (!event || typeof event !== 'object') {
      console.error('❌ [RevenueCat Webhook] Invalid payload structure');
      return res.status(400).json({ 
        success: false,
        error: 'Invalid webhook payload structure' 
      });
    }
    
    const eventType = event.type || event.event;
    const appUserId = event.app_user_id;
    const productId = event.product_id;
    
    // Validate required fields
    if (!eventType || !appUserId) {
      console.error('❌ [RevenueCat Webhook] Missing required fields:', { eventType, appUserId });
      return res.status(400).json({ 
        success: false,
        error: 'Missing required fields: type and app_user_id' 
      });
    }
    
    console.log(`📥 [RevenueCat Webhook] Event received: ${eventType} for user: ${appUserId}${productId ? `, product: ${productId}` : ''}`);
    
    // ========================================
    // 3. HANDLE 24H CONSUMABLE PURCHASES
    // ========================================
    if (
      (eventType === 'INITIAL_PURCHASE' || eventType === 'NON_RENEWING_PURCHASE') &&
      productId === 'com.flashgoal.vip.24h'
    ) {
      try {
        // Calculate 24 hours from now
        const vipExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        
        // Check if user already has VIP access
        const existingVIP = await pool.query(
          `SELECT expiry_date FROM vip_access WHERE user_id = $1`,
          [appUserId]
        );
        
        let finalExpiryDate = vipExpiresAt;
        
        // If user has existing VIP that hasn't expired, add 24h to existing expiry
        if (existingVIP.rows.length > 0) {
          const existingExpiry = new Date(existingVIP.rows[0].expiry_date);
          const now = new Date();
          
          if (existingExpiry > now) {
            // Add 24 hours to existing expiry date
            finalExpiryDate = new Date(existingExpiry.getTime() + 24 * 60 * 60 * 1000);
            console.log(`⏰ [RevenueCat Webhook] Extending existing VIP for user: ${appUserId}`);
          }
        }
        
        // Update or insert VIP access
        await pool.query(
          `INSERT INTO vip_access (user_id, expiry_date, product_id, created_at, updated_at)
           VALUES ($1, $2, $3, NOW(), NOW())
           ON CONFLICT (user_id) 
           DO UPDATE SET 
             expiry_date = $2, 
             product_id = $3, 
             updated_at = NOW()`,
          [appUserId, finalExpiryDate, productId]
        );
        
        console.log(`✅ [RevenueCat Webhook] 24h VIP activated for user: ${appUserId}, expires: ${finalExpiryDate.toISOString()}`);
        
        return res.status(200).json({ 
          success: true,
          message: '24h VIP activated',
          userId: appUserId,
          expiresAt: finalExpiryDate.toISOString()
        });
        
      } catch (dbError) {
        console.error('❌ [RevenueCat Webhook] Database error processing 24h VIP:', dbError);
        return res.status(500).json({ 
          success: false,
          error: 'Failed to process 24h VIP purchase' 
        });
      }
    }
    
    // ========================================
    // 4. HANDLE SUBSCRIPTION RENEWALS
    // ========================================
    if (eventType === 'RENEWAL') {
      try {
        if (!productId) {
          console.error('❌ [RevenueCat Webhook] Missing product_id for RENEWAL event');
          return res.status(400).json({ 
            success: false,
            error: 'Missing product_id for renewal event' 
          });
        }
        
        // Subscriptions are handled by RevenueCat entitlements
        // This is just for logging purposes
        const expiryDate = event.expiration_at_ms 
          ? new Date(event.expiration_at_ms)
          : null;
        
        if (expiryDate && !isNaN(expiryDate.getTime())) {
          await pool.query(
            `INSERT INTO vip_access (user_id, expiry_date, product_id, created_at, updated_at)
             VALUES ($1, $2, $3, NOW(), NOW())
             ON CONFLICT (user_id) 
             DO UPDATE SET 
               expiry_date = $2, 
               product_id = $3, 
               updated_at = NOW()`,
            [appUserId, expiryDate, productId]
          );
          
          console.log(`✅ [RevenueCat Webhook] Subscription renewed for user: ${appUserId}, product: ${productId}`);
        } else {
          console.log(`ℹ️  [RevenueCat Webhook] RENEWAL event logged (entitlements handled by RevenueCat) for user: ${appUserId}`);
        }
        
        return res.status(200).json({ 
          success: true,
          message: 'Renewal processed',
          userId: appUserId,
          productId: productId
        });
        
      } catch (dbError) {
        console.error('❌ [RevenueCat Webhook] Database error processing renewal:', dbError);
        return res.status(500).json({ 
          success: false,
          error: 'Failed to process renewal' 
        });
      }
    }
    
    // ========================================
    // 5. HANDLE CANCELLATION (Optional Logging)
    // ========================================
    if (eventType === 'CANCELLATION') {
      console.log(`ℹ️  [RevenueCat Webhook] Subscription cancelled for user: ${appUserId}, product: ${productId || 'unknown'}`);
      
      // Note: We don't remove VIP access immediately on cancellation
      // RevenueCat will stop renewals, and VIP will expire naturally
      // This is just for logging/debugging purposes
      
      return res.status(200).json({ 
        success: true,
        message: 'Cancellation logged',
        userId: appUserId,
        productId: productId
      });
    }
    
    // ========================================
    // 6. UNKNOWN EVENT TYPE (Log but don't fail)
    // ========================================
    console.log(`⚠️  [RevenueCat Webhook] Unknown event type: ${eventType} for user: ${appUserId}`);
    
    return res.status(200).json({ 
      success: true,
      message: 'Event received but not processed',
      eventType: eventType,
      userId: appUserId
    });
    
  } catch (error) {
    console.error('❌ [RevenueCat Webhook] Unexpected error:', error);
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
      ip: ip
    });
    
    return res.status(500).json({ 
      success: false,
      error: 'Internal server error processing webhook' 
    });
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
    
    // Calculate VIP package type based on remaining days
    let vipPackage = null;
    if (isVIP && expiryDate) {
      const expiry = new Date(expiryDate);
      const now = new Date();
      const daysRemaining = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
      
      if (daysRemaining <= 7) {
        vipPackage = 'weekly';
      } else if (daysRemaining <= 30) {
        vipPackage = 'monthly';
      } else if (daysRemaining <= 90) {
        vipPackage = '3-monthly';
      } else {
        vipPackage = 'yearly';
      }
    }
    
    res.json({ 
      success: true, 
      isVIP, 
      expiryDate, 
      vipPackage,
      productId: isVIP ? result.rows[0].product_id : null 
    });
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
    
    // ========================================
    // 1. VALIDATION: Required fields
    // ========================================
    if (!email || !password || !name) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email, password, and name are required' 
      });
    }
    
    // ========================================
    // 2. VALIDATION: Email format (regex)
    // ========================================
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid email format' 
      });
    }
    
    // ========================================
    // 3. VALIDATION: Password strength
    // Min 8 chars, 1 uppercase, 1 number
    // ========================================
    if (password.length < 8) {
      return res.status(400).json({ 
        success: false, 
        error: 'Password must be at least 8 characters' 
      });
    }
    
    if (!/[A-Z]/.test(password)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Password must contain at least one uppercase letter' 
      });
    }
    
    if (!/[0-9]/.test(password)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Password must contain at least one number' 
      });
    }
    
    // ========================================
    // 4. Normalize email to lowercase
    // ========================================
    const normalizedEmail = email.toLowerCase().trim();
    
    // ========================================
    // 5. Check if email already exists
    // ========================================
    const existing = await pool.query(
      'SELECT id FROM users WHERE email = $1', 
      [normalizedEmail]
    );
    
    if (existing.rows.length > 0) {
      return res.status(409).json({ 
        success: false, 
        error: 'Email already registered' 
      });
    }
    
    // ========================================
    // 6. REFERRAL CODE VALIDATION
    // ========================================
    let referrerUserId = null;
    
    if (referralCode) {
      const referrerQuery = await pool.query(
        'SELECT id, referral_count FROM users WHERE referral_code = $1',
        [referralCode.toUpperCase()]
      );
      
      if (referrerQuery.rows.length === 0) {
        return res.status(400).json({ 
          success: false, 
          error: 'Invalid referral code' 
        });
      }
      
      const referrer = referrerQuery.rows[0];
      
      // Check if referrer has reached max referrals (2)
      if (referrer.referral_count >= 2) {
        return res.status(400).json({ 
          success: false, 
          error: 'This referral code has reached its maximum usage limit' 
        });
      }
      
      referrerUserId = referrer.id;
    }
    
    // ========================================
    // 7. Hash password (bcrypt with 12 rounds)
    // ========================================
    const passwordHash = await bcrypt.hash(password, 12);
    
    // ========================================
    // 8. Generate unique referral code for new user
    // ========================================
    const newReferralCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    
    // ========================================
    // 9. Insert new user
    // ========================================
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, name, referral_code, referred_by) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING id, email, name, referral_code`,
      [normalizedEmail, passwordHash, name, newReferralCode, referralCode ? referralCode.toUpperCase() : null]
    );
    
    const newUser = result.rows[0];
    
    // ========================================
    // 10. REFERRAL REWARD SYSTEM
    // ========================================
    if (referrerUserId) {
      try {
        // A) Give referrer 24h VIP bonus
        const vipExpiryDate = new Date();
        vipExpiryDate.setHours(vipExpiryDate.getHours() + 24);
        
        await pool.query(
          `INSERT INTO vip_access (user_id, expiry_date, product_id) 
           VALUES ($1, $2, 'referral_bonus')
           ON CONFLICT (user_id) 
           DO UPDATE SET 
             expiry_date = CASE 
               WHEN vip_access.expiry_date > NOW() 
               THEN vip_access.expiry_date + INTERVAL '24 hours'
               ELSE $2
             END,
             updated_at = NOW()`,
          [referrerUserId.toString(), vipExpiryDate]
        );
        
        // B) Update referrer's referral count
        await pool.query(
          'UPDATE users SET referral_count = referral_count + 1 WHERE id = $1',
          [referrerUserId]
        );
        
        // C) Create referral record
        await pool.query(
          `INSERT INTO referrals (referrer_code, referrer_user_id, referred_user_id, referred_email, status, bonus_given)
           VALUES ($1, $2, $3, $4, 'completed', true)`,
          [referralCode.toUpperCase(), referrerUserId, newUser.id, normalizedEmail]
        );
        
      } catch (referralError) {
        // Log referral error but don't fail registration
        // Production: Use proper logging service (e.g., Sentry, Winston)
        if (process.env.NODE_ENV !== 'production') {
          console.warn('Referral bonus error:', referralError.message);
        }
      }
    }
    
    // ========================================
    // 11. Generate JWT token
    // ========================================
    const token = jwt.sign(
      { userId: newUser.id, email: newUser.email }, 
      JWT_SECRET, 
      { expiresIn: '30d' }
    );
    
    // ========================================
    // 12. Return success response (201 Created)
    // ========================================
    res.status(201).json({ 
      success: true, 
      token, 
      userId: newUser.id,
      user: { 
        email: newUser.email, 
        name: newUser.name,
        referralCode: newUser.referral_code
      }
    });
    
  } catch (error) {
    // Production: Use proper logging service (e.g., Sentry, Winston)
    if (process.env.NODE_ENV !== 'production') {
      console.warn('Registration error:', error.message);
    }
    
    res.status(500).json({ 
      success: false, 
      error: 'Registration failed. Please try again.' 
    });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', rateLimitLogin, async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  
  try {
    const { email, password } = req.body;
    
    // ========================================
    // 1. VALIDATION: Required fields
    // ========================================
    if (!email || !password) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email and password are required' 
      });
    }
    
    // ========================================
    // 2. VALIDATION: Email format (regex)
    // ========================================
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid email format' 
      });
    }
    
    // ========================================
    // 3. Normalize email to lowercase (match register behavior)
    // ========================================
    const normalizedEmail = email.toLowerCase().trim();
    
    // ========================================
    // 4. Get user (SELECT specific columns only)
    // ========================================
    const result = await pool.query(
      'SELECT id, email, password_hash, name FROM users WHERE email = $1', 
      [normalizedEmail]
    );
    
    // Track failed login attempt
    if (result.rows.length === 0) {
      // Record failed attempt for rate limiting
      const attempts = loginAttemptStore.get(ip) || [];
      attempts.push(Date.now());
      loginAttemptStore.set(ip, attempts);
      
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid credentials' 
      });
    }
    
    const user = result.rows[0];
    
    // ========================================
    // 5. Check password (bcrypt)
    // ========================================
    const valid = await bcrypt.compare(password, user.password_hash);
    
    if (!valid) {
      // Record failed attempt for rate limiting
      const attempts = loginAttemptStore.get(ip) || [];
      attempts.push(Date.now());
      loginAttemptStore.set(ip, attempts);
      
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid credentials' 
      });
    }
    
    // ========================================
    // 6. Check VIP status
    // ========================================
    const vipCheck = await pool.query(
      'SELECT expiry_date, product_id FROM vip_access WHERE user_id = $1 AND expiry_date > NOW()',
      [user.id.toString()]
    );
    
    const isVIP = vipCheck.rows.length > 0;
    const vipExpiresAt = isVIP ? vipCheck.rows[0].expiry_date : null;
    
    // ========================================
    // 6.5. Calculate VIP package type based on remaining days
    // ========================================
    let vipPackage = null;
    if (isVIP && vipExpiresAt) {
      const expiryDate = new Date(vipExpiresAt);
      const now = new Date();
      const daysRemaining = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
      
      // Determine package type based on remaining days
      if (daysRemaining <= 7) {
        vipPackage = 'weekly';
      } else if (daysRemaining <= 30) {
        vipPackage = 'monthly';
      } else if (daysRemaining <= 90) {
        vipPackage = '3-monthly';
      } else {
        vipPackage = 'yearly';
      }
    }
    
    // ========================================
    // 7. Generate JWT token
    // ========================================
    const token = jwt.sign(
      { userId: user.id, email: user.email }, 
      JWT_SECRET, 
      { expiresIn: '30d' }
    );
    
    // ========================================
    // 8. Clear failed login attempts on success
    // ========================================
    loginAttemptStore.delete(ip);
    
    // ========================================
    // 9. Return success response
    // ========================================
    res.json({ 
      success: true, 
      token, 
      userId: user.id,
      isVIP,
      vipExpiresAt,
      vipPackage,
      user: { 
        email: user.email, 
        name: user.name 
      }
    });
    
  } catch (error) {
    // Production-safe error logging (no sensitive data)
    if (process.env.NODE_ENV !== 'production') {
      console.error('Login error:', error.message);
    }
    
    res.status(500).json({ 
      success: false, 
      error: 'Login failed. Please try again.' 
    });
  }
});

// GET /api/auth/validate
app.get('/api/auth/validate', async (req, res) => {
  try {
    // ========================================
    // 1. Extract & validate authorization header
    // ========================================
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        valid: false, 
        error: 'Invalid authorization header format' 
      });
    }
    
    // ========================================
    // 2. Extract & trim token
    // ========================================
    const token = authHeader.replace('Bearer ', '').trim();
    
    if (!token) {
      return res.status(401).json({ 
        valid: false, 
        error: 'No token provided' 
      });
    }
    
    // ========================================
    // 3. Verify JWT token
    // ========================================
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // ========================================
    // 4. Validate token payload structure
    // ========================================
    if (!decoded.userId) {
      return res.status(401).json({ 
        valid: false, 
        error: 'Invalid token payload' 
      });
    }
    
    // ========================================
    // 5. Check if user still exists + get user data
    // ========================================
    const userResult = await pool.query(
      'SELECT id, email, name FROM users WHERE id = $1',
      [decoded.userId]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(401).json({ 
        valid: false, 
        error: 'User not found' 
      });
    }
    
    const user = userResult.rows[0];
    
    // ========================================
    // 6. Check VIP status
    // ========================================
    const vipResult = await pool.query(
      'SELECT expiry_date, product_id FROM vip_access WHERE user_id = $1 AND expiry_date > NOW()',
      [user.id.toString()]
    );
    
    const isVIP = vipResult.rows.length > 0;
    const vipExpiresAt = isVIP ? vipResult.rows[0].expiry_date : null;
    
    // ========================================
    // 6.5. Calculate VIP package type based on remaining days
    // ========================================
    let vipPackage = null;
    if (isVIP && vipExpiresAt) {
      const expiryDate = new Date(vipExpiresAt);
      const now = new Date();
      const daysRemaining = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
      
      // Determine package type based on remaining days
      if (daysRemaining <= 7) {
        vipPackage = 'weekly';
      } else if (daysRemaining <= 30) {
        vipPackage = 'monthly';
      } else if (daysRemaining <= 90) {
        vipPackage = '3-monthly';
      } else {
        vipPackage = 'yearly';
      }
    }
    
    // ========================================
    // 7. Return success response (200 OK)
    // ========================================
    res.json({ 
      valid: true, 
      userId: user.id,
      isVIP,
      vipExpiresAt,
      vipPackage,
      user: {
        email: user.email,
        name: user.name
      }
    });
    
  } catch (error) {
    // ========================================
    // 8. Production-safe error handling
    // ========================================
    
    // Log in development only
    if (process.env.NODE_ENV !== 'production') {
      console.error('Token validation error:', error.message);
    }
    
    // Specific error handling for JWT errors
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        valid: false, 
        error: 'Token expired' 
      });
    }
    
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ 
        valid: false, 
        error: 'Invalid token' 
      });
    }
    
    // Generic server error
    res.status(500).json({ 
      valid: false, 
      error: 'Token validation failed' 
    });
  }
});

// POST /api/auth/forgot-password
app.post('/api/auth/forgot-password', rateLimitForgotPassword, async (req, res) => {
  try {
    const { email } = req.body;
    
    // ========================================
    // 1. VALIDATION: Email required
    // ========================================
    if (!email) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email is required' 
      });
    }
    
    // ========================================
    // 2. VALIDATION: Email format (regex)
    // ========================================
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid email format' 
      });
    }
    
    // ========================================
    // 3. Normalize email to lowercase (match login/register)
    // ========================================
    const normalizedEmail = email.toLowerCase().trim();
    
    // ========================================
    // 4. Get user (SELECT specific columns only)
    // ========================================
    const result = await pool.query(
      'SELECT id, email FROM users WHERE email = $1',
      [normalizedEmail]
    );
    
    if (result.rows.length === 0) {
      // Don't reveal if email exists (security)
      return res.json({ success: true });
    }
    
    const user = result.rows[0];
    
    // ========================================
    // 5. Generate reset token (plain) & hash it
    // ========================================
    const resetToken = crypto.randomBytes(32).toString('hex'); // Plain token for email
    const tokenHash = crypto.createHash('sha256').update(resetToken).digest('hex'); // Hash for DB
    const resetExpires = Date.now() + 15 * 60 * 1000; // 15 minutes
    
    // ========================================
    // 6. Store HASHED token in database (CRITICAL SECURITY)
    // ========================================
    await pool.query(
      'UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3',
      [tokenHash, resetExpires, user.id]
    );
    
    // ========================================
    // 7. Send email with PLAIN token
    // ========================================
    try {
      const resetLink = `flashgoal://reset-password?token=${resetToken}`;
      
      await emailTransporter.sendMail({
        to: normalizedEmail,
        subject: 'FlashGoal - Şifre Sıfırlama',
        html: `
          <h2>Şifre Sıfırlama</h2>
          <p>Şifrenizi sıfırlamak için aşağıdaki linke tıklayın:</p>
          <a href="${resetLink}">Şifremi Sıfırla</a>
          <p>Bu link 15 dakika geçerlidir.</p>
          <p style="color: #999; font-size: 12px;">Eğer bu isteği siz yapmadıysanız, bu e-postayı görmezden gelebilirsiniz.</p>
        `
      });
    } catch (emailError) {
      // Log email error but don't reveal to user (security)
      if (process.env.NODE_ENV !== 'production') {
        console.error('Email send error:', emailError.message);
      }
      // Still return success to prevent email enumeration
    }
    
    // ========================================
    // 8. Always return success (security)
    // ========================================
    res.json({ success: true });
    
  } catch (error) {
    // Production-safe error logging (no sensitive data)
    if (process.env.NODE_ENV !== 'production') {
      console.error('Forgot password error:', error.message);
    }
    
    res.status(500).json({ 
      success: false, 
      error: 'Failed to process request. Please try again.' 
    });
  }
});

// POST /api/auth/reset-password
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    
    // ========================================
    // 1. VALIDATION: Required fields
    // ========================================
    if (!token || !newPassword) {
      return res.status(400).json({ 
        success: false, 
        error: 'Token and new password are required' 
      });
    }
    
    // ========================================
    // 2. VALIDATION: Password strength
    // ========================================
    if (newPassword.length < 8) {
      return res.status(400).json({ 
        success: false, 
        error: 'Password must be at least 8 characters' 
      });
    }
    
    if (!/[A-Z]/.test(newPassword)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Password must contain at least one uppercase letter' 
      });
    }
    
    if (!/[0-9]/.test(newPassword)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Password must contain at least one number' 
      });
    }
    
    // ========================================
    // 3. Hash the token for database lookup
    // ========================================
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    
    // ========================================
    // 4. Find user with valid token (SELECT specific columns)
    // ========================================
    const result = await pool.query(
      'SELECT id, email FROM users WHERE reset_token = $1 AND reset_token_expires > $2',
      [tokenHash, Date.now()]
    );
    
    if (result.rows.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid or expired token' 
      });
    }
    
    const user = result.rows[0];
    
    // ========================================
    // 5. Hash new password (bcrypt with 12 rounds)
    // ========================================
    const passwordHash = await bcrypt.hash(newPassword, 12);
    
    // ========================================
    // 6. Update password and clear reset token
    // ========================================
    await pool.query(
      'UPDATE users SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2',
      [passwordHash, user.id]
    );
    
    // ========================================
    // 7. Return success response
    // ========================================
    res.json({ success: true });
    
  } catch (error) {
    // Production-safe error logging (no sensitive data)
    if (process.env.NODE_ENV !== 'production') {
      console.error('Reset password error:', error.message);
    }
    
    res.status(500).json({ 
      success: false, 
      error: 'Failed to reset password. Please try again.' 
    });
  }
});

// ==========================================
// DEPRECATED: GET /api/user/vip-status
// ==========================================
// This endpoint has been REMOVED (deprecated as of November 5, 2025)
// 
// REASON:
// - Duplicate functionality with /api/auth/validate
// - /api/auth/validate already returns complete VIP status (isVIP, vipExpiresAt)
// - Maintenance burden (two endpoints doing the same thing)
// - Inconsistent response format compared to other auth endpoints
//
// MIGRATION:
// Frontend should use GET /api/auth/validate instead
// Response includes: { valid, userId, isVIP, vipExpiresAt, user: { email, name } }
//
// REMOVED CODE (for reference):
// app.get('/api/user/vip-status', async (req, res) => {
//   try {
//     const token = req.headers.authorization?.replace('Bearer ', '');
//     const decoded = jwt.verify(token, JWT_SECRET);
//     
//     const result = await pool.query(
//       'SELECT * FROM vip_access WHERE user_id = $1 AND expiry_date > NOW()',
//       [decoded.userId.toString()]
//     );
//     
//     if (result.rows.length > 0) {
//       const vip = result.rows[0];
//       res.json({
//         isVIP: true,
//         expiresAt: vip.expiry_date,
//         subscriptionType: vip.product_id
//       });
//     } else {
//       res.json({ isVIP: false });
//     }
//   } catch (error) {
//     res.status(401).json({ isVIP: false });
//   }
// });
// ==========================================

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

// ==========================================
// SERVER-SIDE PRICING TABLE (CRITICAL SECURITY)
// ==========================================
// Client CANNOT control prices - server determines amount based on productId
const PRODUCTS = {
  'vip-daily': { 
    amount: 9900,      // 99 TRY in cents
    days: 1,
    name: 'FlashGoal VIP - 1 Gün',
    description: '24 saat premium tahmin erişimi'
  },
  'vip-weekly': { 
    amount: 39900,     // 399 TRY in cents
    days: 7,
    name: 'FlashGoal VIP - 1 Hafta',
    description: '7 gün premium tahmin erişimi'
  },
  'vip-monthly': { 
    amount: 99900,     // 999 TRY in cents
    days: 30,
    name: 'FlashGoal VIP - 1 Ay',
    description: '30 gün premium tahmin erişimi'
  },
  'vip-quarterly': { 
    amount: 199900,    // 1999 TRY in cents
    days: 90,
    name: 'FlashGoal VIP - 3 Ay',
    description: '90 gün premium tahmin erişimi'
  }
};

// ==========================================
// POST /api/payments/create-checkout-session
// SECURE PAYMENT ENDPOINT (JWT + Rate Limit + Server-side Pricing)
// ==========================================
app.post('/api/payments/create-checkout-session', 
  authenticateToken,      // 1️⃣ JWT Authentication (req.user extracted from token)
  rateLimitPayment,       // 2️⃣ Rate limiting (3 attempts per 15 min)
  async (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;
    
    try {
      // ========================================
      // 3️⃣ INPUT VALIDATION
      // ========================================
      const { productId } = req.body;
      
      // Validate productId required
      if (!productId) {
        return res.status(400).json({ 
          success: false, 
          error: 'Product ID is required' 
        });
      }
      
      // Validate productId exists in server pricing table
      const product = PRODUCTS[productId];
      if (!product) {
        return res.status(400).json({ 
          success: false, 
          error: 'Invalid product ID' 
        });
      }
      
      // ========================================
      // 4️⃣ SERVER-SIDE PRICING (CRITICAL!)
      // Use server-defined prices - NEVER trust client
      // ========================================
      const { amount, days, name, description } = product;
      const userId = req.user.id; // From JWT token (NOT from client!)
      const userEmail = req.user.email; // From JWT token
      
      // ========================================
      // 5️⃣ CREATE STRIPE CHECKOUT SESSION
      // ========================================
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: 'try',
            product_data: {
              name: name,
              description: description,
            },
            unit_amount: amount, // Server-controlled amount (in cents)
          },
          quantity: 1,
        }],
        mode: 'payment',
        success_url: `${process.env.FRONTEND_URL || 'https://app.flashgoal.app'}/user/(tabs)/predictions?success=true`,
        cancel_url: `${process.env.FRONTEND_URL || 'https://app.flashgoal.app'}/user/(tabs)/predictions`,
        customer_email: userEmail,
        metadata: {
          userId: userId.toString(),
          productId: productId,
          days: days.toString(),
          amount: amount.toString()
        },
      });
      
      // ========================================
      // 6️⃣ DATABASE LOGGING (Audit Trail)
      // ========================================
      await pool.query(
        `INSERT INTO payment_attempts 
         (user_id, product_id, amount, currency, stripe_session_id, status, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          userId,
          productId,
          amount,
          'try',
          session.id,
          'initiated',
          ip,
          req.headers['user-agent'] || 'unknown'
        ]
      );
      
      // ========================================
      // 7️⃣ SUCCESS RESPONSE
      // ========================================
      res.json({
        success: true,
        sessionId: session.id,
        checkoutUrl: session.url,
        product: {
          id: productId,
          name: name,
          amount: amount / 100, // Convert cents to TRY for display
          days: days
        }
      });
      
    } catch (error) {
      // ========================================
      // 8️⃣ PRODUCTION-SAFE ERROR HANDLING
      // ========================================
      
      // Log error in development only (NEVER expose to client)
      if (process.env.NODE_ENV !== 'production') {
        console.error('Payment session error:', error);
      }
      
      // Log failed attempt to database
      try {
        await pool.query(
          `INSERT INTO payment_attempts 
           (user_id, product_id, amount, status, ip_address, user_agent)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            req.user?.id || null,
            req.body.productId || 'unknown',
            0,
            'failed',
            ip,
            req.headers['user-agent'] || 'unknown'
          ]
        );
      } catch (logError) {
        // Silent fail for logging errors
        if (process.env.NODE_ENV !== 'production') {
          console.error('Failed to log error:', logError);
        }
      }
      
      // Generic user-friendly error (NO sensitive data)
      res.status(500).json({ 
        success: false, 
        error: 'Payment session creation failed. Please try again later.' 
      });
    }
  }
);

// ==========================================
// POST /api/payments/verify
// SECURE PAYMENT VERIFICATION (JWT + Ownership Check + Idempotent)
// ==========================================
app.post('/api/payments/verify', 
  authenticateToken,      // 1️⃣ JWT Authentication (req.user from token)
  rateLimitPayment,       // 2️⃣ Rate limiting (5 attempts per 15 min)
  async (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;
    
    try {
      // ========================================
      // 3️⃣ INPUT VALIDATION
      // ========================================
      const { sessionId } = req.body;
      
      // Validate sessionId required
      if (!sessionId) {
        return res.status(400).json({ 
          success: false, 
          error: 'Session ID is required' 
        });
      }
      
      // Validate sessionId format (Stripe checkout session format)
      if (!sessionId.startsWith('cs_')) {
        return res.status(400).json({ 
          success: false, 
          error: 'Invalid session ID format' 
        });
      }
      
      // ========================================
      // 4️⃣ DUPLICATE PAYMENT CHECK (Idempotent)
      // Critical: Same payment should not activate VIP twice
      // ========================================
      const existingPayment = await pool.query(
        `SELECT id, status, user_id FROM payment_attempts 
         WHERE stripe_session_id = $1`,
        [sessionId]
      );
      
      if (existingPayment.rows.length > 0) {
        const payment = existingPayment.rows[0];
        
        // If already completed, return success (idempotent behavior)
        if (payment.status === 'completed') {
          // Get VIP info for response
          const vipInfo = await pool.query(
            'SELECT expiry_date, product_id FROM vip_access WHERE user_id = $1',
            [payment.user_id]
          );
          
          return res.json({
            success: true,
            message: 'Payment already processed',
            alreadyProcessed: true,
            vipExpiresAt: vipInfo.rows[0]?.expiry_date || null
          });
        }
        
        // If failed before, allow retry (don't block legitimate retries)
        if (payment.status === 'failed') {
          // Continue to process
        }
      }
      
      // ========================================
      // 5️⃣ RETRIEVE STRIPE CHECKOUT SESSION
      // Get ALL data from Stripe - NEVER trust client
      // ========================================
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      
      // ========================================
      // 6️⃣ PAYMENT STATUS VERIFICATION
      // ========================================
      if (session.payment_status !== 'paid') {
        return res.status(400).json({ 
          success: false, 
          error: 'Payment not completed',
          paymentStatus: session.payment_status
        });
      }
      
      // ========================================
      // 7️⃣ EXTRACT DATA FROM STRIPE METADATA
      // CRITICAL: Get userId, productId, days from Stripe (NOT client!)
      // ========================================
      const stripeUserId = session.metadata?.userId;
      const productId = session.metadata?.productId;
      const days = parseInt(session.metadata?.days || '0');
      const amount = parseInt(session.metadata?.amount || '0');
      
      // Validate metadata exists
      if (!stripeUserId || !productId || !days) {
        return res.status(400).json({ 
          success: false, 
          error: 'Invalid payment metadata' 
        });
      }
      
      // ========================================
      // 8️⃣ OWNERSHIP VERIFICATION (CRITICAL SECURITY)
      // Verify that the authenticated user owns this payment
      // ========================================
      if (stripeUserId !== req.user.id.toString()) {
        // Log suspicious activity
        await pool.query(
          `INSERT INTO payment_attempts 
           (user_id, product_id, amount, stripe_session_id, status, ip_address, user_agent)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            req.user.id,
            'suspicious',
            0,
            sessionId,
            'unauthorized_access_attempt',
            ip,
            req.headers['user-agent'] || 'unknown'
          ]
        );
        
        return res.status(403).json({ 
          success: false, 
          error: 'This payment does not belong to you' 
        });
      }
      
      // ========================================
      // 9️⃣ VIP ACTIVATION (Server-controlled)
      // ========================================
      
      // Calculate expiry date (from Stripe metadata - server-controlled)
      const expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() + days);
      
      // ========================================
      // 🔟 DATABASE TRANSACTION (Atomic Operation)
      // Either both succeed or both fail
      // ========================================
      await pool.query('BEGIN');
      
      try {
        // Update payment_attempts table
        await pool.query(
          `UPDATE payment_attempts 
           SET status = $1, updated_at = NOW() 
           WHERE stripe_session_id = $2`,
          ['completed', sessionId]
        );
        
        // If no rows updated, insert new record
        const updateResult = await pool.query(
          'SELECT id FROM payment_attempts WHERE stripe_session_id = $1',
          [sessionId]
        );
        
        if (updateResult.rows.length === 0) {
          await pool.query(
            `INSERT INTO payment_attempts 
             (user_id, product_id, amount, currency, stripe_session_id, status, ip_address, user_agent)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              req.user.id,
              productId,
              amount,
              'try',
              sessionId,
              'completed',
              ip,
              req.headers['user-agent'] || 'unknown'
            ]
          );
        }
        
        // Activate VIP access
        await pool.query(
          `INSERT INTO vip_access (user_id, product_id, expiry_date) 
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id) 
           DO UPDATE SET 
             product_id = $2, 
             expiry_date = CASE 
               WHEN vip_access.expiry_date > NOW() 
               THEN vip_access.expiry_date + ($3 - NOW())
               ELSE $3
             END,
             updated_at = NOW()`,
          [req.user.id, productId, expiryDate]
        );
        
        // Commit transaction
        await pool.query('COMMIT');
        
      } catch (dbError) {
        // Rollback on any error
        await pool.query('ROLLBACK');
        throw dbError;
      }
      
      // ========================================
      // ⓫ SUCCESS RESPONSE
      // ========================================
      res.json({
        success: true,
        message: 'VIP activated successfully',
        vipExpiresAt: expiryDate,
        product: {
          id: productId,
          days: days
        },
        payment: {
          sessionId: sessionId,
          amount: amount / 100, // Convert cents to TRY
          currency: 'try'
        }
      });
      
    } catch (error) {
      // ========================================
      // ⓬ PRODUCTION-SAFE ERROR HANDLING
      // ========================================
      
      // Log error in development only (NEVER expose to client)
      if (process.env.NODE_ENV !== 'production') {
        console.error('Payment verification error:', error);
      }
      
      // Log failed verification attempt to database
      try {
        await pool.query(
          `INSERT INTO payment_attempts 
           (user_id, product_id, amount, stripe_session_id, status, ip_address, user_agent)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            req.user?.id || null,
            'unknown',
            0,
            req.body.sessionId || 'unknown',
            'failed',
            ip,
            req.headers['user-agent'] || 'unknown'
          ]
        );
      } catch (logError) {
        // Silent fail for logging errors
        if (process.env.NODE_ENV !== 'production') {
          console.error('Failed to log error:', logError);
        }
      }
      
      // Handle specific Stripe errors
      if (error.type === 'StripeInvalidRequestError') {
        return res.status(400).json({ 
          success: false, 
          error: 'Invalid session ID' 
        });
      }
      
      // Generic user-friendly error (NO sensitive data)
      res.status(500).json({ 
        success: false, 
        error: 'Payment verification failed. Please contact support if payment was successful.' 
      });
    }
  }
);

// Get Stripe publishable key
app.get('/api/payments/config', (req, res) => {
  res.json({ 
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY 
  });
});

});

