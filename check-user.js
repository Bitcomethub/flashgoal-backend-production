const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://postgres:bGDVgRqCdXWIpkEGVjdqhiRaqKNYPVzL@switchyard.proxy.rlwy.net:45367/railway'
});

async function checkUser() {
  try {
    // test7 var mı?
    const result = await pool.query(
      'SELECT id, email, password_hash FROM users WHERE email = $1',
      ['test7@flashgoal.app']
    );
    
    console.log('📊 test7@flashgoal.app:', result.rows);
    
    // Tüm userları göster
    const all = await pool.query('SELECT id, email, name, created_at FROM users ORDER BY id DESC LIMIT 10');
    console.log('\n📋 Last 10 users:');
    all.rows.forEach(u => {
      console.log(`  ${u.id} | ${u.email} | ${u.name || 'N/A'} | ${u.created_at}`);
    });
    
    await pool.end();
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

checkUser();
