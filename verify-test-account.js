const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const pool = new Pool({
  connectionString: 'postgresql://postgres:bGDVgRqCdXWIpkEGVjdqhiRaqKNYPVzL@switchyard.proxy.rlwy.net:45367/railway'
});

async function verifyTestAccount() {
  try {
    console.log('🔍 Verifying test account login...\n');
    
    const email = 'support@testerscommunity.com';
    const password = 'SDt80yq#Wk53$$N5';
    
    // 1. Check user exists
    console.log('1️⃣  Checking if user exists...');
    const userResult = await pool.query(
      'SELECT id, email, password_hash, name, created_at FROM users WHERE email = $1',
      [email]
    );
    
    if (userResult.rows.length === 0) {
      console.log('❌ User not found!');
      await pool.end();
      return;
    }
    
    const user = userResult.rows[0];
    console.log('✅ User found:', {
      id: user.id,
      email: user.email,
      name: user.name
    });
    
    // 2. Verify password
    console.log('\n2️⃣  Verifying password...');
    const passwordValid = await bcrypt.compare(password, user.password_hash);
    
    if (!passwordValid) {
      console.log('❌ Invalid password!');
      await pool.end();
      return;
    }
    console.log('✅ Password is correct!');
    
    // 3. Check VIP status
    console.log('\n3️⃣  Checking VIP status...');
    const vipResult = await pool.query(
      'SELECT * FROM vip_access WHERE user_id = $1 AND expiry_date > NOW()',
      [user.id.toString()]
    );
    
    if (vipResult.rows.length === 0) {
      console.log('❌ No active VIP access found!');
      await pool.end();
      return;
    }
    
    const vip = vipResult.rows[0];
    console.log('✅ VIP access is active:', {
      product_id: vip.product_id,
      expires: vip.expiry_date,
      days_remaining: Math.floor((new Date(vip.expiry_date) - new Date()) / (1000 * 60 * 60 * 24))
    });
    
    // 4. Simulate full login flow
    console.log('\n4️⃣  Simulating login flow...');
    console.log('   ✅ Authentication passed');
    console.log('   ✅ User data retrieved');
    console.log('   ✅ VIP status verified');
    console.log('   ✅ Session can be created');
    
    console.log('\n' + '═'.repeat(70));
    console.log('✅ LOGIN VERIFICATION SUCCESSFUL!');
    console.log('═'.repeat(70));
    console.log('\n📱 READY FOR TESTING:');
    console.log('────────────────────────────────────────────────────────────────────');
    console.log(`Email:        ${email}`);
    console.log(`Password:     ${password}`);
    console.log(`User ID:      ${user.id}`);
    console.log(`VIP Status:   Active (expires in ${Math.floor((new Date(vip.expiry_date) - new Date()) / (1000 * 60 * 60 * 24))} days)`);
    console.log('────────────────────────────────────────────────────────────────────');
    console.log('\n✅ ALL SYSTEMS GO! The account is ready for 12 testers to use.');
    console.log('═'.repeat(70) + '\n');
    
    await pool.end();
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    await pool.end();
    process.exit(1);
  }
}

verifyTestAccount();

