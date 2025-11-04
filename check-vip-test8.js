const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://postgres:bGDVgRqCdXWIpkEGVjdqhiRaqKNYPVzL@switchyard.proxy.rlwy.net:45367/railway'
});

async function check() {
  const vip = await pool.query(
    'SELECT * FROM vip_access WHERE user_id = $1',
    ['4']  // test8 user_id = 4
  );
  
  console.log('💎 VIP Status for test8 (user_id=4):');
  console.log(vip.rows.length > 0 ? '✅ VIP!' : '❌ NOT VIP');
  if (vip.rows.length > 0) {
    console.log('Expires:', vip.rows[0].expiry_date);
  }
  
  await pool.end();
}

check();
