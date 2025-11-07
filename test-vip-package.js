/**
 * TEST SCRIPT: VIP Package Field
 * 
 * This script tests the new vipPackage field in the backend responses
 * Tests both /api/auth/login and /api/auth/validate endpoints
 */

const axios = require('axios');

const BASE_URL = 'http://localhost:3000';

// Color codes for console output
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m',
  reset: '\x1b[0m'
};

function log(color, ...args) {
  console.log(color, ...args, colors.reset);
}

async function testLoginVipPackage() {
  log(colors.blue, '\n=== TEST 1: Login Endpoint with VIP Package ===');
  
  try {
    const response = await axios.post(`${BASE_URL}/api/auth/login`, {
      email: 'test@example.com',  // Replace with a VIP user
      password: 'test123'          // Replace with correct password
    });
    
    log(colors.green, '✓ Login successful');
    console.log('Response data:', JSON.stringify(response.data, null, 2));
    
    // Check if vipPackage is present
    if (response.data.vipPackage !== undefined) {
      log(colors.green, '✓ vipPackage field is present:', response.data.vipPackage);
      
      // Validate vipPackage value
      const validPackages = ['weekly', 'monthly', '3-monthly', 'yearly', null];
      if (validPackages.includes(response.data.vipPackage)) {
        log(colors.green, '✓ vipPackage has valid value');
      } else {
        log(colors.red, '✗ vipPackage has invalid value:', response.data.vipPackage);
      }
      
      // Check if VIP status and package match
      if (response.data.isVIP && !response.data.vipPackage) {
        log(colors.yellow, '⚠ User is VIP but vipPackage is null');
      } else if (!response.data.isVIP && response.data.vipPackage) {
        log(colors.red, '✗ User is not VIP but vipPackage is set:', response.data.vipPackage);
      } else {
        log(colors.green, '✓ VIP status and package are consistent');
      }
      
      // Calculate expected package based on expiry date
      if (response.data.isVIP && response.data.vipExpiresAt) {
        const expiryDate = new Date(response.data.vipExpiresAt);
        const now = new Date();
        const daysRemaining = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
        
        let expectedPackage;
        if (daysRemaining <= 7) {
          expectedPackage = 'weekly';
        } else if (daysRemaining <= 30) {
          expectedPackage = 'monthly';
        } else if (daysRemaining <= 90) {
          expectedPackage = '3-monthly';
        } else {
          expectedPackage = 'yearly';
        }
        
        log(colors.blue, `Days remaining: ${daysRemaining}`);
        log(colors.blue, `Expected package: ${expectedPackage}`);
        log(colors.blue, `Actual package: ${response.data.vipPackage}`);
        
        if (response.data.vipPackage === expectedPackage) {
          log(colors.green, '✓ Package calculation is correct');
        } else {
          log(colors.red, '✗ Package calculation mismatch');
        }
      }
    } else {
      log(colors.red, '✗ vipPackage field is missing from response');
    }
    
    return response.data.token;
  } catch (error) {
    log(colors.red, '✗ Login failed:', error.response?.data || error.message);
    return null;
  }
}

async function testValidateVipPackage(token) {
  log(colors.blue, '\n=== TEST 2: Validate Endpoint with VIP Package ===');
  
  if (!token) {
    log(colors.yellow, '⚠ Skipping validate test (no token from login)');
    return;
  }
  
  try {
    const response = await axios.get(`${BASE_URL}/api/auth/validate`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    log(colors.green, '✓ Token validation successful');
    console.log('Response data:', JSON.stringify(response.data, null, 2));
    
    // Check if vipPackage is present
    if (response.data.vipPackage !== undefined) {
      log(colors.green, '✓ vipPackage field is present:', response.data.vipPackage);
      
      // Validate vipPackage value
      const validPackages = ['weekly', 'monthly', '3-monthly', 'yearly', null];
      if (validPackages.includes(response.data.vipPackage)) {
        log(colors.green, '✓ vipPackage has valid value');
      } else {
        log(colors.red, '✗ vipPackage has invalid value:', response.data.vipPackage);
      }
      
      // Check if VIP status and package match
      if (response.data.isVIP && !response.data.vipPackage) {
        log(colors.yellow, '⚠ User is VIP but vipPackage is null');
      } else if (!response.data.isVIP && response.data.vipPackage) {
        log(colors.red, '✗ User is not VIP but vipPackage is set:', response.data.vipPackage);
      } else {
        log(colors.green, '✓ VIP status and package are consistent');
      }
      
      // Calculate expected package based on expiry date
      if (response.data.isVIP && response.data.vipExpiresAt) {
        const expiryDate = new Date(response.data.vipExpiresAt);
        const now = new Date();
        const daysRemaining = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
        
        let expectedPackage;
        if (daysRemaining <= 7) {
          expectedPackage = 'weekly';
        } else if (daysRemaining <= 30) {
          expectedPackage = 'monthly';
        } else if (daysRemaining <= 90) {
          expectedPackage = '3-monthly';
        } else {
          expectedPackage = 'yearly';
        }
        
        log(colors.blue, `Days remaining: ${daysRemaining}`);
        log(colors.blue, `Expected package: ${expectedPackage}`);
        log(colors.blue, `Actual package: ${response.data.vipPackage}`);
        
        if (response.data.vipPackage === expectedPackage) {
          log(colors.green, '✓ Package calculation is correct');
        } else {
          log(colors.red, '✗ Package calculation mismatch');
        }
      }
    } else {
      log(colors.red, '✗ vipPackage field is missing from response');
    }
  } catch (error) {
    log(colors.red, '✗ Token validation failed:', error.response?.data || error.message);
  }
}

async function runTests() {
  log(colors.blue, '╔═══════════════════════════════════════════════════════════╗');
  log(colors.blue, '║       VIP PACKAGE FIELD TEST SUITE                        ║');
  log(colors.blue, '╚═══════════════════════════════════════════════════════════╝');
  
  log(colors.yellow, '\nNote: Update the email/password in this script with a VIP user');
  log(colors.yellow, 'to see the full test results.\n');
  
  const token = await testLoginVipPackage();
  await testValidateVipPackage(token);
  
  log(colors.blue, '\n=== TEST SUMMARY ===');
  log(colors.blue, 'Package types based on days remaining:');
  log(colors.blue, '  • <= 7 days:  weekly');
  log(colors.blue, '  • <= 30 days: monthly');
  log(colors.blue, '  • <= 90 days: 3-monthly');
  log(colors.blue, '  • > 90 days:  yearly');
  log(colors.blue, '  • Non-VIP:    null');
}

// Run the tests
runTests().catch(console.error);

