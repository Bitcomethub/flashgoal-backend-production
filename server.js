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
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
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

app.get('/api/predictions', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM predictions ORDER BY created_at DESC');
    res.json({ success: true, count: result.rows.length, predictions: result.rows });
  } catch (error) {
    console.error('❌ Get predictions:', error);
    res.status(500).json({ success: false, error: 'Failed' });
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
    // Aktif tahminleri çek
    const predictions = await pool.query(
      'SELECT * FROM predictions WHERE status = $1',
      ['active']
    );

    let updated = 0;

    for (const pred of predictions.rows) {
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
      
      if (fixture && fixture.fixture.status.short === 'FT') {
        // Maç bitti, skorları güncelle
        await pool.query(
          'UPDATE predictions SET home_score = $1, away_score = $2, status = $3 WHERE id = $4',
          [
            fixture.goals.home,
            fixture.goals.away,
            'completed',
            pred.id
          ]
        );
        updated++;
      }
    }

    res.json({ success: true, updated });
  } catch (error) {
    console.error('Update scores error:', error);
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
        
        const status = fixture.fixture.status.short;
        const predType = pred.prediction_type.toUpperCase();
        
        const isFinished = ["FT", "AET", "PEN"].includes(status);
        const isHT = ["HT", "2H", "FT", "AET", "PEN"].includes(status);
        
        const shouldCheck = predType.includes("İY") ? isHT : isFinished;
        
        if (shouldCheck) {
          const homeGoals = fixture.goals.home || 0;
          const awayGoals = fixture.goals.away || 0;
          const total = homeGoals + awayGoals;
          
          const htScore = fixture.score.halftime;
          const htTotal = (htScore?.home || 0) + (htScore?.away || 0);
          
          let result = null;
          
          if (predType.includes("İY")) {
            if (predType.includes("0.5Ü")) result = htTotal > 0.5 ? "won" : "lost";
            else if (predType.includes("1.5Ü")) result = htTotal > 1.5 ? "won" : "lost";
            else if (predType.includes("2.5Ü")) result = htTotal > 2.5 ? "won" : "lost";
          } 
          else if (predType.includes("MB")) {
            if (predType.includes("0.5Ü")) result = total > 0.5 ? "won" : "lost";
            else if (predType.includes("1.5Ü")) result = total > 1.5 ? "won" : "lost";
            else if (predType.includes("2.5Ü")) result = total > 2.5 ? "won" : "lost";
            else if (predType.includes("3.5Ü")) result = total > 3.5 ? "won" : "lost";
            else if (predType.includes("4.5Ü")) result = total > 4.5 ? "won" : "lost";
            else if (predType.includes("KGV")) result = homeGoals > 0 && awayGoals > 0 ? "won" : "lost";
          }
          
          if (result) {
            await pool.query(
              "UPDATE predictions SET status = $1, result = $1, updated_at = NOW() WHERE id = $2",
              [result, pred.id]
            );
            console.log(`✅ #${pred.id}: ${result.toUpperCase()}`);
          }
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

