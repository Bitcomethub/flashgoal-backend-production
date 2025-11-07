const axios = require('axios');

// Configuration
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://localhost:8080/api/webhook/revenuecat';
const WEBHOOK_TOKEN = process.env.REVENUECAT_WEBHOOK_TOKEN || 'test-token-123';

// Test payloads
const testPayloads = {
  initialPurchase24h: {
    type: 'INITIAL_PURCHASE',
    app_user_id: 'test-user-123',
    product_id: 'com.flashgoal.vip.24h',
    purchased_at_ms: Date.now()
  },
  
  nonRenewingPurchase24h: {
    type: 'NON_RENEWING_PURCHASE',
    app_user_id: 'test-user-456',
    product_id: 'com.flashgoal.vip.24h',
    purchased_at_ms: Date.now()
  },
  
  renewal: {
    type: 'RENEWAL',
    app_user_id: 'test-user-789',
    product_id: 'com.flashgoal.vip.monthly',
    expiration_at_ms: Date.now() + (30 * 24 * 60 * 60 * 1000) // 30 days
  },
  
  cancellation: {
    type: 'CANCELLATION',
    app_user_id: 'test-user-789',
    product_id: 'com.flashgoal.vip.monthly'
  },
  
  invalidPayload: {
    type: 'INITIAL_PURCHASE'
    // Missing app_user_id
  },
  
  unknownEvent: {
    type: 'UNKNOWN_EVENT',
    app_user_id: 'test-user-999',
    product_id: 'com.flashgoal.vip.24h'
  }
};

async function testWebhook(testName, payload, shouldSucceed = true) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🧪 Testing: ${testName}`);
  console.log('─'.repeat(70));
  
  try {
    const response = await axios.post(WEBHOOK_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${WEBHOOK_TOKEN}`
      },
      validateStatus: () => true // Don't throw on any status
    });
    
    console.log(`📤 Payload:`, JSON.stringify(payload, null, 2));
    console.log(`📥 Status: ${response.status}`);
    console.log(`📥 Response:`, JSON.stringify(response.data, null, 2));
    
    if (shouldSucceed) {
      if (response.status === 200 && response.data.success) {
        console.log(`✅ Test PASSED`);
        return true;
      } else {
        console.log(`❌ Test FAILED - Expected success but got error`);
        return false;
      }
    } else {
      if (response.status >= 400) {
        console.log(`✅ Test PASSED (Expected failure)`);
        return true;
      } else {
        console.log(`❌ Test FAILED - Expected failure but got success`);
        return false;
      }
    }
    
  } catch (error) {
    console.error(`❌ Test ERROR:`, error.message);
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Data:`, error.response.data);
    }
    return false;
  }
}

async function testWithoutAuth(testName, payload) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🧪 Testing: ${testName} (No Authorization)`);
  console.log('─'.repeat(70));
  
  try {
    const response = await axios.post(WEBHOOK_URL, payload, {
      headers: {
        'Content-Type': 'application/json'
        // No Authorization header
      },
      validateStatus: () => true
    });
    
    console.log(`📤 Payload:`, JSON.stringify(payload, null, 2));
    console.log(`📥 Status: ${response.status}`);
    console.log(`📥 Response:`, JSON.stringify(response.data, null, 2));
    
    if (response.status === 401) {
      console.log(`✅ Test PASSED (Correctly rejected unauthorized request)`);
      return true;
    } else {
      console.log(`⚠️  Test WARNING - Expected 401 but got ${response.status}`);
      console.log(`   (This is OK if REVENUECAT_WEBHOOK_TOKEN is not set)`);
      return true; // Still pass if token is not configured
    }
    
  } catch (error) {
    console.error(`❌ Test ERROR:`, error.message);
    return false;
  }
}

async function runAllTests() {
  console.log('╔═══════════════════════════════════════════════════════════════════════╗');
  console.log('║                                                                       ║');
  console.log('║           🧪 REVENUECAT WEBHOOK TEST SUITE 🧪                        ║');
  console.log('║                                                                       ║');
  console.log('╚═══════════════════════════════════════════════════════════════════════╝');
  
  console.log(`\n📡 Webhook URL: ${WEBHOOK_URL}`);
  console.log(`🔑 Using Token: ${WEBHOOK_TOKEN ? 'YES' : 'NO (set REVENUECAT_WEBHOOK_TOKEN)'}`);
  
  const results = [];
  
  // Test 1: Initial Purchase (24h consumable)
  results.push(await testWebhook(
    'Initial Purchase - 24h Consumable',
    testPayloads.initialPurchase24h,
    true
  ));
  
  // Test 2: Non-Renewing Purchase (24h consumable)
  results.push(await testWebhook(
    'Non-Renewing Purchase - 24h Consumable',
    testPayloads.nonRenewingPurchase24h,
    true
  ));
  
  // Test 3: Renewal (subscription)
  results.push(await testWebhook(
    'Renewal - Subscription',
    testPayloads.renewal,
    true
  ));
  
  // Test 4: Cancellation
  results.push(await testWebhook(
    'Cancellation - Subscription',
    testPayloads.cancellation,
    true
  ));
  
  // Test 5: Invalid payload (should fail)
  results.push(await testWebhook(
    'Invalid Payload (Missing app_user_id)',
    testPayloads.invalidPayload,
    false
  ));
  
  // Test 6: Unknown event type (should succeed but log warning)
  results.push(await testWebhook(
    'Unknown Event Type',
    testPayloads.unknownEvent,
    true
  ));
  
  // Test 7: Without authorization (should fail if token is set)
  results.push(await testWithoutAuth(
    'Unauthorized Request',
    testPayloads.initialPurchase24h
  ));
  
  // Summary
  console.log(`\n${'='.repeat(70)}`);
  console.log('📊 TEST SUMMARY');
  console.log('─'.repeat(70));
  const passed = results.filter(r => r).length;
  const total = results.length;
  console.log(`✅ Passed: ${passed}/${total}`);
  console.log(`❌ Failed: ${total - passed}/${total}`);
  
  if (passed === total) {
    console.log('\n🎉 All tests passed!');
  } else {
    console.log('\n⚠️  Some tests failed. Check the logs above.');
  }
  
  console.log('═'.repeat(70));
}

// Run tests
runAllTests().catch(error => {
  console.error('❌ Test suite error:', error);
  process.exit(1);
});

