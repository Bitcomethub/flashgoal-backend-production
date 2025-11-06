# 🧪 SHARED TEST ACCOUNT - FLASHGOAL VIP

## 📋 Account Details

**Email:** `support@testerscommunity.com`  
**Password:** `SDt80yq#Wk53$$N5`  
**Username:** Test User  
**User ID:** 5

---

## 💎 VIP Status

- **Status:** ✅ Active
- **Product ID:** `tester-vip`
- **Created:** November 6, 2025
- **Expires:** November 6, 2026 (365 days)
- **Days Remaining:** 364

---

## ✅ Verification Results

All systems verified and working:

- ✅ User account created successfully
- ✅ Password authentication works
- ✅ VIP access is active
- ✅ Can access all VIP features
- ✅ Login flow tested and verified

---

## 👥 Usage Instructions

### For Testers (12 people will share this account)

1. **Login to FlashGoal app**
   - Email: `support@testerscommunity.com`
   - Password: `SDt80yq#Wk53$$N5`

2. **VIP Features Available**
   - All premium predictions
   - Advanced analytics
   - Priority support
   - Ad-free experience
   - All VIP-only content

3. **Important Notes**
   - This is a **shared account** - 12 testers will use it
   - Do NOT change the password
   - Do NOT change account details
   - Use for testing purposes only
   - Valid for 1 year (until November 6, 2026)

---

## 🔐 Security Details

### Password Generation
- **Length:** 16 characters
- **Composition:** 
  - Uppercase letters: Yes
  - Lowercase letters: Yes
  - Numbers: Yes
  - Special characters: Yes
- **Algorithm:** Cryptographically secure random generation

### Password Hashing
- **Algorithm:** bcrypt
- **Rounds:** 12
- **Hash:** Stored securely in database

---

## 🗄️ Database Records

### Users Table
```sql
id: 5
email: support@testerscommunity.com
password_hash: [bcrypt hash with 12 rounds]
name: Test User
created_at: 2025-11-06 13:21:40
```

### VIP Access Table
```sql
id: 4
user_id: 5
product_id: tester-vip
expiry_date: 2026-11-06 13:21:40
created_at: 2025-11-06 13:21:40
```

---

## 🔧 Management Scripts

### Create Account (Already Done)
```bash
node create-shared-test-account.js
```

### Verify Account
```bash
node verify-test-account.js
```

### Check VIP Status
```bash
node check-vip.js
```

### Check User Details
```bash
node check-user.js
```

---

## 📊 Account Stats

- **Total Testers:** 12
- **Account Type:** Shared VIP
- **Concurrent Users:** All 12 can use simultaneously
- **Session Management:** Each tester gets their own session
- **Data Separation:** None (shared account, shared data)

---

## ⚠️ Important Warnings

1. **DO NOT DELETE** this account during testing period
2. **DO NOT REVOKE** VIP access manually
3. **DO NOT CHANGE** password or email
4. **DO NOT USE** for production purposes
5. **SAVE THIS FILE** - it contains the only copy of the password

---

## 🔄 Renewal / Extension

To extend VIP access:

```sql
UPDATE vip_access 
SET expiry_date = NOW() + INTERVAL '1 year'
WHERE user_id = '5';
```

---

## 📞 Support

If there are any issues with the test account:
1. Run verification script: `node verify-test-account.js`
2. Check database directly using `check-user.js` or `check-vip.js`
3. Re-run creation script if needed: `node create-shared-test-account.js`

---

**Created:** November 6, 2025  
**Status:** ✅ Active and Ready  
**Next Review:** November 6, 2026

