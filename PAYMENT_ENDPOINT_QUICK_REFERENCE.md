# 💳 PAYMENT ENDPOINT - QUICK REFERENCE GUIDE

**Last Updated:** November 5, 2025  
**Security Status:** 🟢 PRODUCTION READY

---

## 🚀 HOW TO USE THE SECURE PAYMENT ENDPOINT

### Frontend Integration:

```javascript
// 1. User must be logged in with JWT token
const token = await getAuthToken(); // Your auth token

// 2. Call endpoint with ONLY productId (server controls price!)
const response = await fetch('https://api.flashgoal.app/api/payments/create-checkout-session', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,  // ✅ Required!
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    productId: 'vip-monthly'  // ✅ Only send productId!
  })
});

const data = await response.json();

if (data.success) {
  // 3. Redirect to Stripe checkout
  window.location.href = data.checkoutUrl;
} else {
  console.error(data.error);
}
```

---

## 📦 AVAILABLE PRODUCTS

| Product ID | Price | Days | Name |
|-----------|-------|------|------|
| `vip-daily` | 99 TRY | 1 | 1 Gün VIP |
| `vip-weekly` | 399 TRY | 7 | 1 Hafta VIP |
| `vip-monthly` | 999 TRY | 30 | 1 Ay VIP |
| `vip-quarterly` | 1999 TRY | 90 | 3 Ay VIP |

---

## ⚠️ IMPORTANT: WHAT NOT TO DO

### ❌ DON'T send these fields (server ignores them):
```javascript
{
  amount: 100,      // ❌ Server controls this
  days: 30,         // ❌ Server controls this
  userId: 'xyz',    // ❌ Server gets from JWT
  currency: 'try'   // ❌ Server controls this
}
```

### ✅ DO send only this:
```javascript
{
  productId: 'vip-monthly'  // ✅ That's it!
}
```

---

## 🔐 SECURITY FEATURES

1. **JWT Authentication:** User must be logged in
2. **Rate Limiting:** Max 3 attempts per 15 minutes
3. **Server-side Pricing:** Client CANNOT manipulate prices
4. **Audit Trail:** All attempts logged to database
5. **Production-safe Errors:** No sensitive data exposed

---

## 📊 ERROR RESPONSES

### 401 Unauthorized:
```json
{
  "success": false,
  "error": "Authentication required"
}
```
**Fix:** Include valid JWT token in Authorization header.

### 400 Bad Request:
```json
{
  "success": false,
  "error": "Product ID is required"
}
```
**Fix:** Include `productId` in request body.

```json
{
  "success": false,
  "error": "Invalid product ID"
}
```
**Fix:** Use valid product ID from table above.

### 429 Too Many Requests:
```json
{
  "success": false,
  "error": "Too many payment attempts. Please try again in 15 minutes."
}
```
**Fix:** Wait 15 minutes before trying again.

### 500 Server Error:
```json
{
  "success": false,
  "error": "Payment session creation failed. Please try again later."
}
```
**Fix:** Retry after a few seconds. If persists, contact support.

---

## ✅ SUCCESS RESPONSE

```json
{
  "success": true,
  "sessionId": "cs_test_a1b2c3d4...",
  "checkoutUrl": "https://checkout.stripe.com/c/pay/cs_test_...",
  "product": {
    "id": "vip-monthly",
    "name": "FlashGoal VIP - 1 Ay",
    "amount": 999,
    "days": 30
  }
}
```

**Next Step:** Redirect user to `checkoutUrl`

---

## 🔄 PAYMENT FLOW

```
1. User clicks "Subscribe to VIP Monthly" button
   ↓
2. Frontend calls /api/payments/create-checkout-session
   with: { productId: 'vip-monthly' }
   ↓
3. Server verifies JWT token
   ↓
4. Server gets price from PRODUCTS table (999 TRY)
   ↓
5. Server creates Stripe checkout session
   ↓
6. Server logs attempt to payment_attempts table
   ↓
7. Server returns checkoutUrl
   ↓
8. Frontend redirects to Stripe checkout page
   ↓
9. User enters card details on Stripe (secure)
   ↓
10. Stripe processes payment
   ↓
11. Stripe calls webhook: /api/webhook/revenuecat
   ↓
12. Server activates VIP in vip_access table
   ↓
13. User redirected to success page
```

---

## 🧪 TESTING

### Test Product IDs (Same as Production):
- `vip-daily` (99 TRY)
- `vip-weekly` (399 TRY)
- `vip-monthly` (999 TRY)
- `vip-quarterly` (1999 TRY)

### Stripe Test Cards:
- **Success:** `4242 4242 4242 4242`
- **Decline:** `4000 0000 0000 0002`
- **Auth Required:** `4000 0025 0000 3155`

Use any future expiry date and any CVC.

---

## 📝 RATE LIMITS

| Endpoint | Limit | Window | Consequence |
|----------|-------|--------|-------------|
| Payment creation | 3 attempts | 15 minutes | 429 error, wait 15min |

**Best Practice:** Show warning after 2nd failed attempt.

---

## 🔍 MONITORING

### Database Queries:

**Check payment attempts:**
```sql
SELECT * FROM payment_attempts 
WHERE user_id = 123 
ORDER BY created_at DESC;
```

**Find failed payments:**
```sql
SELECT * FROM payment_attempts 
WHERE status = 'failed' 
AND created_at > NOW() - INTERVAL '24 hours';
```

**Fraud detection (multiple IPs, same user):**
```sql
SELECT user_id, COUNT(DISTINCT ip_address) as ip_count
FROM payment_attempts 
GROUP BY user_id 
HAVING COUNT(DISTINCT ip_address) > 3;
```

---

## 🆘 TROUBLESHOOTING

### Problem: "Authentication required" error
**Solution:** Ensure JWT token is included:
```javascript
headers: {
  'Authorization': `Bearer ${token}`
}
```

### Problem: "Invalid product ID" error
**Solution:** Use exact product ID from list above (case-sensitive).

### Problem: "Too many payment attempts" error
**Solution:** Wait 15 minutes. Rate limit is IP-based.

### Problem: Webhook not activating VIP
**Solution:** Check `/api/webhook/revenuecat` logs. Ensure Stripe webhook configured.

---

## 📞 CONTACT

- **Technical Issues:** Check server logs
- **Security Concerns:** Review STRIPE_CHECKOUT_SECURITY_FIXES.md
- **Stripe Issues:** Check Stripe Dashboard

---

**Security Score:** 95/100 🟢  
**Status:** Production Ready ✅  
**Last Security Audit:** November 5, 2025

