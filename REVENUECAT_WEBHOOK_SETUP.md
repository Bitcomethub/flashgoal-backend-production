# 🎯 RevenueCat Webhook Handler - Setup Guide

## 📋 Overview

FlashGoal uses RevenueCat for iOS/Android subscriptions and consumable purchases. This webhook handler processes purchase events and manages VIP access in the database.

---

## 🔗 Webhook Endpoint

**URL:** `POST /api/webhook/revenuecat`

**Location:** `server.js` (lines 2159-2380)

---

## ✅ Features

### 1. **Webhook Signature Verification**
- Verifies RevenueCat authorization header
- Uses `REVENUECAT_WEBHOOK_TOKEN` environment variable
- Prevents unauthorized requests

### 2. **Event Types Handled**

| Event Type | Description | Action |
|------------|-------------|--------|
| `INITIAL_PURCHASE` | First purchase of 24h consumable | Activates 24h VIP |
| `NON_RENEWING_PURCHASE` | Non-renewing consumable purchase | Activates 24h VIP |
| `RENEWAL` | Subscription renewal | Logs event (optional) |
| `CANCELLATION` | Subscription cancelled | Logs event (optional) |

### 3. **24h Consumable Logic**
- **Product ID:** `com.flashgoal.vip.24h`
- **Behavior:** 
  - If user has no VIP: Sets expiry to 24 hours from now
  - If user has active VIP: Adds 24 hours to existing expiry date
- **Database:** Updates `vip_access` table

### 4. **Subscriptions**
- Subscriptions are handled by RevenueCat entitlements
- Webhook logs renewal events for debugging
- No webhook action required for subscriptions

---

## 🔧 Setup Instructions

### Step 1: Configure Environment Variable

Add to your `.env` file:

```bash
REVENUECAT_WEBHOOK_TOKEN=your_webhook_token_here
```

**Where to get the token:**
1. Go to RevenueCat Dashboard
2. Project Settings → Webhooks
3. Copy the authorization token from your webhook configuration

### Step 2: Configure Webhook in RevenueCat Dashboard

1. **Navigate to:** Project Settings → Webhooks
2. **Add Webhook URL:**
   ```
   https://your-domain.com/api/webhook/revenuecat
   ```
   Or for local testing with ngrok:
   ```
   https://your-ngrok-url.ngrok.io/api/webhook/revenuecat
   ```

3. **Select Events:**
   - ✅ `INITIAL_PURCHASE`
   - ✅ `NON_RENEWING_PURCHASE`
   - ✅ `RENEWAL` (optional - for logging)
   - ✅ `CANCELLATION` (optional - for logging)

4. **Copy Authorization Token:**
   - Copy the token from RevenueCat
   - Add to `.env` as `REVENUECAT_WEBHOOK_TOKEN`

### Step 3: Verify Database Schema

Ensure `vip_access` table exists:

```sql
CREATE TABLE IF NOT EXISTS vip_access (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) UNIQUE NOT NULL,
  expiry_date TIMESTAMP NOT NULL,
  product_id VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

---

## 📊 Webhook Payload Examples

### 24h Consumable Purchase

```json
{
  "type": "INITIAL_PURCHASE",
  "app_user_id": "user123",
  "product_id": "com.flashgoal.vip.24h",
  "purchased_at_ms": 1699123456789
}
```

### Subscription Renewal

```json
{
  "type": "RENEWAL",
  "app_user_id": "user123",
  "product_id": "com.flashgoal.vip.monthly",
  "expiration_at_ms": 1701715456789
}
```

### Cancellation

```json
{
  "type": "CANCELLATION",
  "app_user_id": "user123",
  "product_id": "com.flashgoal.vip.monthly"
}
```

---

## 🧪 Testing

### 1. Test Webhook Locally

Use the test script:

```bash
node test-revenuecat-webhook.js
```

### 2. Test with RevenueCat Dashboard

1. Go to RevenueCat Dashboard → Webhooks
2. Click "Send Test Event"
3. Select event type
4. Check server logs for confirmation

### 3. Test with ngrok (Real Purchases)

```bash
# Install ngrok
npm install -g ngrok

# Start your server
node server.js

# In another terminal, start ngrok
ngrok http 8080

# Copy ngrok URL to RevenueCat webhook configuration
# Make a test purchase in your app
# Check webhook logs
```

### 4. Verify VIP Activation

```bash
# Check VIP status for a user
node check-vip.js

# Or query database directly
SELECT * FROM vip_access WHERE user_id = 'user123';
```

---

## 🔍 Response Format

### Success Response (24h VIP)

```json
{
  "success": true,
  "message": "24h VIP activated",
  "userId": "user123",
  "expiresAt": "2025-11-07T13:21:40.672Z"
}
```

### Success Response (Renewal)

```json
{
  "success": true,
  "message": "Renewal processed",
  "userId": "user123",
  "productId": "com.flashgoal.vip.monthly"
}
```

### Error Response

```json
{
  "success": false,
  "error": "Missing required fields: type and app_user_id"
}
```

---

## 🛡️ Security Features

1. **Signature Verification**
   - Validates `Authorization: Bearer <token>` header
   - Prevents unauthorized webhook calls
   - Returns 401 if token is invalid

2. **Input Validation**
   - Validates payload structure
   - Checks required fields
   - Validates data types

3. **Error Handling**
   - Comprehensive error logging
   - Graceful error responses
   - Database error handling

4. **Logging**
   - All events logged with emojis for easy scanning
   - IP address tracking
   - Detailed error messages

---

## 📝 Logging

The webhook logs all events with clear prefixes:

- ✅ `✅ [RevenueCat Webhook]` - Success
- ❌ `❌ [RevenueCat Webhook]` - Error
- ⚠️ `⚠️  [RevenueCat Webhook]` - Warning
- 📥 `📥 [RevenueCat Webhook]` - Event received
- ℹ️ `ℹ️  [RevenueCat Webhook]` - Info

**Example logs:**
```
✅ [RevenueCat Webhook] Signature verified
📥 [RevenueCat Webhook] Event received: INITIAL_PURCHASE for user: user123, product: com.flashgoal.vip.24h
✅ [RevenueCat Webhook] 24h VIP activated for user: user123, expires: 2025-11-07T13:21:40.672Z
```

---

## 🔄 24h Consumable Logic Details

### Scenario 1: New User (No VIP)
- User purchases 24h consumable
- VIP expires: `NOW() + 24 hours`

### Scenario 2: User with Active VIP
- User purchases 24h consumable
- Existing VIP expires: `2025-11-10 10:00:00`
- New VIP expires: `2025-11-11 10:00:00` (adds 24h)

### Scenario 3: User with Expired VIP
- User purchases 24h consumable
- VIP expires: `NOW() + 24 hours` (starts fresh)

---

## 🚨 Troubleshooting

### Webhook Not Receiving Events

1. **Check webhook URL:**
   - Verify URL is correct in RevenueCat dashboard
   - Test with curl or Postman

2. **Check authorization:**
   - Verify `REVENUECAT_WEBHOOK_TOKEN` is set
   - Check token matches RevenueCat dashboard

3. **Check server logs:**
   - Look for webhook request logs
   - Check for error messages

### VIP Not Activating

1. **Check database:**
   ```sql
   SELECT * FROM vip_access WHERE user_id = 'user123';
   ```

2. **Check product ID:**
   - Verify product ID is exactly: `com.flashgoal.vip.24h`
   - Case-sensitive!

3. **Check event type:**
   - Must be `INITIAL_PURCHASE` or `NON_RENEWING_PURCHASE`
   - Check webhook logs for received event type

### Database Errors

1. **Check connection:**
   - Verify database connection string
   - Check database is accessible

2. **Check table exists:**
   ```sql
   SELECT * FROM information_schema.tables WHERE table_name = 'vip_access';
   ```

---

## 📚 Related Files

- `server.js` - Main webhook handler (lines 2159-2380)
- `test-revenuecat-webhook.js` - Test script
- `check-vip.js` - VIP status checker

---

## 🔗 RevenueCat Documentation

- [RevenueCat Webhooks](https://docs.revenuecat.com/docs/webhooks)
- [Webhook Events](https://docs.revenuecat.com/docs/webhooks#event-types)
- [Webhook Security](https://docs.revenuecat.com/docs/webhooks#security)

---

**Last Updated:** November 6, 2025  
**Status:** ✅ Production Ready

