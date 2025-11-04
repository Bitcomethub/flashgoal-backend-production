const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://postgres:bGDVgRqCdXWIpkEGVjdqhiRaqKNYPVzL@switchyard.proxy.rlwy.net:45367/railway'
});

async function checkDB() {
  try {
    // Tabloları listele
    const tables = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);
    console.log('📋 TABLES:', tables.rows);
    
    // Users tablosu varsa structure göster
    const columns = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'users'
    `);
    console.log('\n👤 USERS COLUMNS:', columns.rows);
    
    await pool.end();
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

checkDB();
