# 🎯 VIP PACKAGE FIELD - QUICK REFERENCE

**Last Updated:** November 7, 2025

---

## 📊 PACKAGE TYPES

| Days Remaining | Package Value | Usage |
|----------------|---------------|-------|
| **≤ 7 days**   | `'weekly'`    | Show expiry warning |
| **≤ 30 days**  | `'monthly'`   | Standard VIP |
| **≤ 90 days**  | `'3-monthly'` | Premium VIP |
| **> 90 days**  | `'yearly'`    | Long-term VIP |
| **Non-VIP**    | `null`        | Free user |

---

## 🔌 UPDATED ENDPOINTS

### 1️⃣ POST `/api/auth/login`

**Request:**
```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

**Response:**
```json
{
  "success": true,
  "token": "jwt_token_here",
  "userId": 123,
  "isVIP": true,
  "vipExpiresAt": "2025-12-31T23:59:59.999Z",
  "vipPackage": "monthly",  // ← NEW FIELD
  "user": {
    "email": "user@example.com",
    "name": "User Name"
  }
}
```

---

### 2️⃣ GET `/api/auth/validate`

**Request:**
```
GET /api/auth/validate
Authorization: Bearer {token}
```

**Response:**
```json
{
  "valid": true,
  "userId": 123,
  "isVIP": true,
  "vipExpiresAt": "2025-12-31T23:59:59.999Z",
  "vipPackage": "monthly",  // ← NEW FIELD
  "user": {
    "email": "user@example.com",
    "name": "User Name"
  }
}
```

---

### 3️⃣ GET `/api/vip/check/:userId`

**Request:**
```
GET /api/vip/check/123
```

**Response:**
```json
{
  "success": true,
  "isVIP": true,
  "expiryDate": "2025-12-31T23:59:59.999Z",
  "vipPackage": "monthly",  // ← NEW FIELD
  "productId": "rc_monthly_premium"
}
```

---

## 💻 FRONTEND USAGE

### Example 1: Display VIP Badge

```javascript
const { isVIP, vipPackage } = userData;

if (isVIP) {
  const badges = {
    'weekly': '🔥 Weekly VIP',
    'monthly': '⭐ Monthly VIP',
    '3-monthly': '💎 Premium VIP',
    'yearly': '👑 Elite VIP'
  };
  
  return <Badge>{badges[vipPackage]}</Badge>;
}
```

### Example 2: Show Expiry Warning

```javascript
if (vipPackage === 'weekly') {
  showWarning('Your VIP expires in less than 7 days! Renew now!');
}
```

### Example 3: Conditional Features

```javascript
const isPremium = ['3-monthly', 'yearly'].includes(vipPackage);

if (isPremium) {
  enableExclusiveFeatures();
}
```

---

## 🧮 CALCULATION LOGIC

```javascript
// Automatic calculation on every request
let vipPackage = null;
if (isVIP && vipExpiresAt) {
  const expiryDate = new Date(vipExpiresAt);
  const now = new Date();
  const daysRemaining = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
  
  if (daysRemaining <= 7) {
    vipPackage = 'weekly';
  } else if (daysRemaining <= 30) {
    vipPackage = 'monthly';
  } else if (daysRemaining <= 90) {
    vipPackage = '3-monthly';
  } else {
    vipPackage = 'yearly';
  }
}
```

---

## ✅ KEY FEATURES

- ✅ **No Database Changes** - Calculated from existing `expiry_date`
- ✅ **Always Accurate** - Recalculated on every request
- ✅ **Backward Compatible** - Only adds new field, doesn't break existing code
- ✅ **Type Safe** - Returns one of 5 possible values
- ✅ **Edge Case Handled** - Uses `Math.ceil()` for expiry day

---

## 🧪 TESTING

Run the test script:
```bash
node test-vip-package.js
```

Test manually with curl:
```bash
# Login
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"test123"}'

# Validate
curl http://localhost:3000/api/auth/validate \
  -H "Authorization: Bearer YOUR_TOKEN"

# Check VIP
curl http://localhost:3000/api/vip/check/123
```

---

## 📝 NOTES

1. **Dynamic Calculation:** Package type changes automatically as expiry approaches
2. **Non-VIP Users:** Will always receive `vipPackage: null`
3. **Consistency:** All three endpoints use the same calculation logic
4. **No Migration:** Works with existing database schema
5. **UTC Time:** All calculations use server time

---

## 🚨 IMPORTANT

⚠️ The `vipPackage` field is **NOT stored in the database**  
⚠️ It is **calculated dynamically** on each request  
⚠️ This ensures it's **always up-to-date**

---

**Ready for production! 🚀**

