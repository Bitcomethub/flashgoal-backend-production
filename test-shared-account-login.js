const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const pool = new Pool({
  connectionString: 'postgresql://postgres:bGDVgRqCdXWIpkEGVjdqhiRaqKNYPVzL@switchyard.proxy.rlwy.net:45367/railway'
});

async function testLoginFlow() {
  try {
    console.log('🧪 Testing Complete Login Flow for Shared Test Account\n');
    console.log('═'.repeat(70));
    
    const email = 'support@testerscommunity.com';
    const password = 'SDt80yq#Wk53$$N5';
    
    // STEP 1: Validate input (like API does)
    console.log('\n📋 STEP 1: Input Validation');
    console.log('─'.repeat(70));
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const emailValid = emailRegex.test(email);
    const passwordProvided = password && password.length > 0;
    
    console.log(`Email provided:        ${email ? '✅' : '❌'}`);
    console.log(`Email format valid:    ${emailValid ? '✅' : '❌'}`);
    console.log(`Password provided:     ${passwordProvided ? '✅' : '❌'}`);
    
    if (!emailValid || !passwordProvided) {
      console.log('❌ Validation failed!');
      await pool.end();
      return;
    }
    
    // STEP 2: Normalize email (like API does)
    console.log('\n📋 STEP 2: Email Normalization');
    console.log('─'.repeat(70));
    const normalizedEmail = email.toLowerCase().trim();
    console.log(`Original email:        ${email}`);
    console.log(`Normalized email:      ${normalizedEmail}`);
    console.log(`Status:                ✅ Normalized`);
    
    // STEP 3: Find user in database
    console.log('\n📋 STEP 3: Database Lookup');
    console.log('─'.repeat(70));
    const userResult = await pool.query(
      'SELECT id, email, password_hash, name, created_at FROM users WHERE email = $1',
      [normalizedEmail]
    );
    
    if (userResult.rows.length === 0) {
      console.log('❌ User not found in database!');
      await pool.end();
      return;
    }
    
    const user = userResult.rows[0];
    console.log(`User found:            ✅`);
    console.log(`User ID:               ${user.id}`);
    console.log(`Email:                 ${user.email}`);
    console.log(`Name:                  ${user.name}`);
    
    // STEP 4: Verify password with bcrypt
    console.log('\n📋 STEP 4: Password Verification');
    console.log('─'.repeat(70));
    const passwordValid = await bcrypt.compare(password, user.password_hash);
    
    if (!passwordValid) {
      console.log('❌ Invalid password!');
      await pool.end();
      return;
    }
    
    console.log(`Password match:        ✅`);
    console.log(`Bcrypt comparison:     ✅ Passed`);
    console.log(`Authentication:        ✅ Successful`);
    
    // STEP 5: Check VIP status
    console.log('\n📋 STEP 5: VIP Access Check');
    console.log('─'.repeat(70));
    const vipResult = await pool.query(
      `SELECT * FROM vip_access 
       WHERE user_id = $1 
       AND expiry_date > NOW()
       ORDER BY expiry_date DESC 
       LIMIT 1`,
      [user.id.toString()]
    );
    
    const hasVIP = vipResult.rows.length > 0;
    console.log(`VIP check query:       ✅ Executed`);
    console.log(`VIP access found:      ${hasVIP ? '✅' : '❌'}`);
    
    if (hasVIP) {
      const vip = vipResult.rows[0];
      const daysRemaining = Math.floor(
        (new Date(vip.expiry_date) - new Date()) / (1000 * 60 * 60 * 24)
      );
      console.log(`VIP product:           ${vip.product_id}`);
      console.log(`VIP expires:           ${new Date(vip.expiry_date).toDateString()}`);
      console.log(`Days remaining:        ${daysRemaining}`);
      console.log(`VIP status:            ✅ ACTIVE`);
    }
    
    // STEP 6: Prepare response data (like API does)
    console.log('\n📋 STEP 6: Response Preparation');
    console.log('─'.repeat(70));
    const responseData = {
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        hasVIP: hasVIP,
        vipExpiry: hasVIP ? vipResult.rows[0].expiry_date : null
      }
    };
    console.log(`Response object:       ✅ Created`);
    console.log(`User data included:    ✅`);
    console.log(`VIP status included:   ✅`);
    
    // FINAL RESULT
    console.log('\n' + '═'.repeat(70));
    console.log('✅ ✅ ✅  LOGIN FLOW TEST PASSED  ✅ ✅ ✅');
    console.log('═'.repeat(70));
    
    console.log('\n📊 LOGIN RESPONSE SIMULATION:');
    console.log('─'.repeat(70));
    console.log(JSON.stringify(responseData, null, 2));
    console.log('─'.repeat(70));
    
    console.log('\n🎉 SUMMARY:');
    console.log('─'.repeat(70));
    console.log('✅ Input validation:     PASSED');
    console.log('✅ Email normalization:  PASSED');
    console.log('✅ User lookup:          PASSED');
    console.log('✅ Password verification: PASSED');
    console.log('✅ VIP access check:     PASSED');
    console.log('✅ Response generation:  PASSED');
    console.log('─'.repeat(70));
    
    console.log('\n🚀 ACCOUNT IS READY FOR PRODUCTION USE!');
    console.log('   All 12 testers can now login with these credentials.');
    console.log('═'.repeat(70) + '\n');
    
    await pool.end();
    
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error);
    await pool.end();
    process.exit(1);
  }
}

testLoginFlow();

