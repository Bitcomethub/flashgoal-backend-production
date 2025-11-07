# 🚀 RevenueCat Webhook - Quick Reference

## 📍 Endpoint

```
POST /api/webhook/revenuecat
```

## 🔑 Environment Variable

```bash
REVENUECAT_WEBHOOK_TOKEN=your_token_here
```

## 📦 Product IDs

| Product | ID | Type |
|---------|-----|------|
| 24h VIP | `com.flashgoal.vip.24h` | Consumable |
| Monthly VIP | `com.flashgoal.vip.monthly` | Subscription |
| Yearly VIP | `com.flashgoal.vip.yearly` | Subscription |

## 🎯 Event Types

### Handled Events

- ✅ `INITIAL_PURCHASE` - First purchase (24h consumable)
- ✅ `NON_RENEWING_PURCHASE` - Non-renewing purchase (24h consumable)
- ✅ `RENEWAL` - Subscription renewal (logging only)
- ✅ `CANCELLATION` - Subscription cancelled (logging only)

## 🔐 Authorization

**Header:**
```
Authorization: Bearer <REVENUECAT_WEBHOOK_TOKEN>
```

## 📊 24h Consumable Logic

**Product:** `com.flashgoal.vip.24h`

**Behavior:**
- New user: VIP expires in 24 hours
- Existing VIP: Adds 24 hours to current expiry
- Expired VIP: Starts fresh (24 hours from now)

## ✅ Success Response

```json
{
  "success": true,
  "message": "24h VIP activated",
  "userId": "user123",
  "expiresAt": "2025-11-07T13:21:40.672Z"
}
```

## ❌ Error Response

```json
{
  "success": false,
  "error": "Missing required fields: type and app_user_id"
}
```

## 🧪 Test Command

```bash
node test-revenuecat-webhook.js
```

## 📝 Check VIP Status

```bash
node check-vip.js
```

## 🔍 Database Query

```sql
SELECT * FROM vip_access WHERE user_id = 'user123';
```

## 📚 Full Documentation

See `REVENUECAT_WEBHOOK_SETUP.md` for complete setup guide.

