const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: 'postgresql://postgres:bGDVgRqCdXWIpkEGVjdqhiRaqKNYPVzL@switchyard.proxy.rlwy.net:45367/railway'
});

// Generate secure random password
function generateSecurePassword() {
  const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lowercase = 'abcdefghijklmnopqrstuvwxyz';
  const numbers = '0123456789';
  const symbols = '!@#$%^&*';
  
  let password = '';
  
  // Ensure at least 2 of each type
  password += uppercase[crypto.randomInt(0, uppercase.length)];
  password += uppercase[crypto.randomInt(0, uppercase.length)];
  password += lowercase[crypto.randomInt(0, lowercase.length)];
  password += lowercase[crypto.randomInt(0, lowercase.length)];
  password += numbers[crypto.randomInt(0, numbers.length)];
  password += numbers[crypto.randomInt(0, numbers.length)];
  password += symbols[crypto.randomInt(0, symbols.length)];
  password += symbols[crypto.randomInt(0, symbols.length)];
  
  // Fill remaining 8 characters randomly from all sets
  const allChars = uppercase + lowercase + numbers + symbols;
  for (let i = 0; i < 8; i++) {
    password += allChars[crypto.randomInt(0, allChars.length)];
  }
  
  // Shuffle the password
  password = password.split('').sort(() => crypto.randomInt(-1, 2)).join('');
  
  return password;
}

async function createSharedTestAccount() {
  try {
    console.log('🚀 Creating shared test account...\n');
    
    // Account details
    const email = 'support@testerscommunity.com';
    const name = 'Test User';
    const password = generateSecurePassword();
    
    console.log('📝 Generated Password:', password);
    console.log('🔐 Hashing password with bcrypt (12 rounds)...\n');
    
    // Hash password with bcrypt (12 rounds)
    const passwordHash = await bcrypt.hash(password, 12);
    
    // Check if user already exists
    const existing = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );
    
    if (existing.rows.length > 0) {
      console.log('⚠️  User already exists. Deleting old user first...');
      const userId = existing.rows[0].id;
      
      // Delete VIP access first (foreign key)
      await pool.query('DELETE FROM vip_access WHERE user_id = $1', [userId.toString()]);
      
      // Delete user
      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
      console.log('✅ Old user deleted\n');
    }
    
    // Insert user
    console.log('👤 Creating user...');
    const userResult = await pool.query(
      `INSERT INTO users (email, password_hash, name, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       RETURNING id, email, name, created_at`,
      [email, passwordHash, name]
    );
    
    const user = userResult.rows[0];
    console.log('✅ User created:', {
      id: user.id,
      email: user.email,
      name: user.name,
      created_at: user.created_at
    });
    
    // Add VIP access (1 year)
    console.log('\n💎 Adding VIP access...');
    const vipResult = await pool.query(
      `INSERT INTO vip_access (user_id, product_id, expiry_date, created_at, updated_at)
       VALUES ($1, $2, NOW() + INTERVAL '1 year', NOW(), NOW())
       RETURNING id, user_id, product_id, expiry_date`,
      [user.id.toString(), 'tester-vip']
    );
    
    const vip = vipResult.rows[0];
    console.log('✅ VIP access granted:', {
      id: vip.id,
      user_id: vip.user_id,
      product_id: vip.product_id,
      expiry_date: vip.expiry_date
    });
    
    // Verify login works
    console.log('\n🔍 Verifying account...');
    const verifyUser = await pool.query(
      'SELECT id, email, name, created_at FROM users WHERE email = $1',
      [email]
    );
    
    const verifyVIP = await pool.query(
      'SELECT * FROM vip_access WHERE user_id = $1',
      [user.id.toString()]
    );
    
    const passwordValid = await bcrypt.compare(password, passwordHash);
    
    console.log('\n' + '═'.repeat(60));
    console.log('✅ SHARED TEST ACCOUNT CREATED SUCCESSFULLY!');
    console.log('═'.repeat(60));
    console.log('\n📋 ACCOUNT DETAILS:');
    console.log('─'.repeat(60));
    console.log(`Email:     ${email}`);
    console.log(`Password:  ${password}`);
    console.log(`Username:  ${name}`);
    console.log(`User ID:   ${user.id}`);
    console.log('─'.repeat(60));
    console.log('\n💎 VIP STATUS:');
    console.log('─'.repeat(60));
    console.log(`Status:      Active`);
    console.log(`Product ID:  ${vip.product_id}`);
    console.log(`Expires:     ${new Date(vip.expiry_date).toLocaleDateString('en-US', { 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    })}`);
    console.log(`Created:     ${new Date(vip.created_at).toLocaleDateString('en-US', { 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    })}`);
    console.log('─'.repeat(60));
    console.log('\n✅ VERIFICATION:');
    console.log('─'.repeat(60));
    console.log(`✅ User created:        ${verifyUser.rows.length > 0 ? 'YES' : 'NO'}`);
    console.log(`✅ VIP active:          ${verifyVIP.rows.length > 0 ? 'YES' : 'NO'}`);
    console.log(`✅ Password valid:      ${passwordValid ? 'YES' : 'NO'}`);
    console.log(`✅ Can access VIP:      ${verifyVIP.rows.length > 0 && new Date(verifyVIP.rows[0].expiry_date) > new Date() ? 'YES' : 'NO'}`);
    console.log('─'.repeat(60));
    console.log('\n📝 NOTES:');
    console.log('• This account is shared by 12 testers');
    console.log('• All testers can use the same credentials');
    console.log('• VIP access is valid for 1 year');
    console.log('• Save the password securely!\n');
    console.log('═'.repeat(60));
    
    await pool.end();
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error(error);
    await pool.end();
    process.exit(1);
  }
}

createSharedTestAccount();

