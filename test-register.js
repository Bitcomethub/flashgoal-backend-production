/**
 * TEST FILE - POST /api/auth/register
 * 
 * Run: node test-register.js
 * 
 * Tests all validation and security features
 */

const API_URL = process.env.API_URL || 'http://localhost:8080';

// Helper function to test registration
async function testRegister(testName, payload, expectedStatus) {
  try {
    const response = await fetch(`${API_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    const data = await response.json();
    const status = response.status;
    
    const passed = status === expectedStatus;
    console.log(`${passed ? '✅' : '❌'} ${testName}`);
    console.log(`   Status: ${status} (expected ${expectedStatus})`);
    console.log(`   Response:`, JSON.stringify(data, null, 2));
    console.log('');
    
    return { passed, status, data };
  } catch (error) {
    console.log(`❌ ${testName}`);
    console.log(`   Error:`, error.message);
    console.log('');
    return { passed: false, error };
  }
}

// Run all tests
async function runTests() {
  console.log('🧪 TESTING POST /api/auth/register\n');
  console.log('═══════════════════════════════════════\n');
  
  let testsPassed = 0;
  let testsFailed = 0;
  
  // ========================================
  // 1. Test: Missing email
  // ========================================
  let result = await testRegister(
    'Test 1: Missing email',
    { password: 'Test1234', name: 'John Doe' },
    400
  );
  result.passed ? testsPassed++ : testsFailed++;
  
  // ========================================
  // 2. Test: Missing password
  // ========================================
  result = await testRegister(
    'Test 2: Missing password',
    { email: 'test@example.com', name: 'John Doe' },
    400
  );
  result.passed ? testsPassed++ : testsFailed++;
  
  // ========================================
  // 3. Test: Missing name
  // ========================================
  result = await testRegister(
    'Test 3: Missing name',
    { email: 'test@example.com', password: 'Test1234' },
    400
  );
  result.passed ? testsPassed++ : testsFailed++;
  
  // ========================================
  // 4. Test: Invalid email format
  // ========================================
  result = await testRegister(
    'Test 4: Invalid email format',
    { email: 'notanemail', password: 'Test1234', name: 'John Doe' },
    400
  );
  result.passed ? testsPassed++ : testsFailed++;
  
  // ========================================
  // 5. Test: Password too short
  // ========================================
  result = await testRegister(
    'Test 5: Password too short',
    { email: 'test@example.com', password: 'Test12', name: 'John Doe' },
    400
  );
  result.passed ? testsPassed++ : testsFailed++;
  
  // ========================================
  // 6. Test: Password missing uppercase
  // ========================================
  result = await testRegister(
    'Test 6: Password missing uppercase',
    { email: 'test@example.com', password: 'test1234', name: 'John Doe' },
    400
  );
  result.passed ? testsPassed++ : testsFailed++;
  
  // ========================================
  // 7. Test: Password missing number
  // ========================================
  result = await testRegister(
    'Test 7: Password missing number',
    { email: 'test@example.com', password: 'TestPassword', name: 'John Doe' },
    400
  );
  result.passed ? testsPassed++ : testsFailed++;
  
  // ========================================
  // 8. Test: Invalid referral code
  // ========================================
  result = await testRegister(
    'Test 8: Invalid referral code',
    { email: 'test@example.com', password: 'Test1234', name: 'John Doe', referralCode: 'INVALID123' },
    400
  );
  result.passed ? testsPassed++ : testsFailed++;
  
  // ========================================
  // 9. Test: Valid registration (no referral)
  // ========================================
  const timestamp = Date.now();
  result = await testRegister(
    'Test 9: Valid registration (no referral)',
    { 
      email: `test${timestamp}@example.com`, 
      password: 'Test1234', 
      name: 'John Doe' 
    },
    201
  );
  
  const firstUser = result.data;
  result.passed ? testsPassed++ : testsFailed++;
  
  // ========================================
  // 10. Test: Duplicate email (case insensitive)
  // ========================================
  result = await testRegister(
    'Test 10: Duplicate email (case insensitive)',
    { 
      email: `TEST${timestamp}@EXAMPLE.COM`, 
      password: 'Test1234', 
      name: 'Jane Doe' 
    },
    409
  );
  result.passed ? testsPassed++ : testsFailed++;
  
  // ========================================
  // 11. Test: Valid registration with referral code
  // ========================================
  if (firstUser && firstUser.user && firstUser.user.referralCode) {
    const timestamp2 = Date.now();
    result = await testRegister(
      'Test 11: Valid registration with referral code',
      { 
        email: `referred${timestamp2}@example.com`, 
        password: 'Test5678', 
        name: 'Referred User',
        referralCode: firstUser.user.referralCode
      },
      201
    );
    result.passed ? testsPassed++ : testsFailed++;
    
    if (result.passed) {
      console.log('🎉 Referral bonus should be given to referrer!');
      console.log(`   Referrer should get 24h VIP`);
      console.log(`   Check user ID: ${firstUser.userId}\n`);
    }
  }
  
  // ========================================
  // Summary
  // ========================================
  console.log('═══════════════════════════════════════');
  console.log(`\n📊 RESULTS: ${testsPassed}/${testsPassed + testsFailed} tests passed\n`);
  
  if (testsFailed === 0) {
    console.log('🎉 ALL TESTS PASSED! Endpoint is production-ready.\n');
  } else {
    console.log(`⚠️  ${testsFailed} tests failed. Please review.\n`);
  }
}

// Run tests
runTests().catch(error => {
  console.error('Test suite error:', error);
  process.exit(1);
});

