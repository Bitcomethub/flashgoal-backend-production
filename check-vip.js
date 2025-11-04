const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://postgres:bGDVgRqCdXWIpkEGVjdqhiRaqKNYPVzL@switchyard.proxy.rlwy.net:45367/railway'
});

async function checkVIP() {
  try {
    const columns = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'vip_access'
    `);
    console.log('💎 VIP_ACCESS COLUMNS:', columns.rows);
    
    const data = await pool.query('SELECT * FROM vip_access LIMIT 5');
    console.log('\n📝 SAMPLE DATA:', data.rows);
    
    await pool.end();
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

checkVIP();
