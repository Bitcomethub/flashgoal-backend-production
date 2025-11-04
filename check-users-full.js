const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://postgres:bGDVgRqCdXWIpkEGVjdqhiRaqKNYPVzL@switchyard.proxy.rlwy.net:45367/railway'
});

async function checkUsers() {
  try {
    // Tüm tabloları tekrar kontrol
    const tables = await pool.query(`
      SELECT table_schema, table_name 
      FROM information_schema.tables 
      WHERE table_type = 'BASE TABLE'
      ORDER BY table_schema, table_name
    `);
    console.log('📋 ALL TABLES:', tables.rows);
    
    // Users tablosu farklı schema'da olabilir
    const usersCheck = await pool.query(`
      SELECT table_schema, table_name 
      FROM information_schema.tables 
      WHERE table_name = 'users'
    `);
    console.log('\n👤 USERS TABLE LOCATION:', usersCheck.rows);
    
    // Public schema'daki users
    try {
      const columns = await pool.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = 'users' AND table_schema = 'public'
      `);
      console.log('\n📊 PUBLIC.USERS COLUMNS:', columns.rows);
      
      const count = await pool.query('SELECT COUNT(*) FROM users');
      console.log('\n📈 USERS COUNT:', count.rows[0]);
      
      const sample = await pool.query('SELECT * FROM users LIMIT 3');
      console.log('\n📝 SAMPLE USERS:', sample.rows);
    } catch (e) {
      console.log('\n❌ No users table in public schema');
    }
    
    await pool.end();
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

checkUsers();
