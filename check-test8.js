const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://postgres:bGDVgRqCdXWIpkEGVjdqhiRaqKNYPVzL@switchyard.proxy.rlwy.net:45367/railway'
});

async function check() {
  try {
    const result = await pool.query(
      'SELECT id, email, password_hash, name, created_at FROM users WHERE email = $1',
      ['test8@flashgoal.app']
    );
    
    if (result.rows.length > 0) {
      const user = result.rows[0];
      console.log('✅ User EXISTS:');
      console.log(`  ID: ${user.id}`);
      console.log(`  Email: ${user.email}`);
      console.log(`  Name: ${user.name}`);
      console.log(`  Password Hash: ${user.password_hash.substring(0, 20)}...`);
      console.log(`  Created: ${user.created_at}`);
      
      // Password test
      const bcrypt = require('bcrypt');
      const valid = await bcrypt.compare('Test1234!', user.password_hash);
      console.log(`\n🔐 Password "Test1234!" match: ${valid ? '✅ YES' : '❌ NO'}`);
    } else {
      console.log('❌ User NOT FOUND');
    }
    
    await pool.end();
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

check();
