const asyncHandler = require('express-async-handler');
const crypto = require('crypto');
const { User } = require('../models');
const { signToken } = require('../utils/jwt');
const { ok, fail, created } = require('../utils/response');
const { issueOtp, verifyOtp, OTP_TTL_MIN } = require('../services/userOtp.service');
const { sendUserOtp, sendUserWelcome } = require('../services/userMailer.service');
const { normalizePhone } = require('../services/cashfree.service');
const { creditReferrerForFirstLogin } = require('../services/referEarn.service');
// NOTE: v3 referral system (Jun 2026) — referrer is paid the moment the
// referee completes their profile (effectively "first login"). Booking is
// no longer the trigger. The payment hook still calls the legacy v2 path
// as an idempotent safety net.

const normalize = (email) => String(email || '').toLowerCase().trim();

// ── Phase-1 demo login backdoor ──────────────────────────────────────────
// A fixed email + OTP so the mobile app can be opened for UI review without a
// live inbox. NOTE: remove (or gate behind an env flag) before going live.
const DEMO_EMAIL = 'demo@reconnct.app';
const DEMO_CODE = '123456';
const isDemo = (email) => normalize(email) === DEMO_EMAIL;

const issueAuthToken = (user) =>
  signToken({ id: user.id, kind: 'user', email: user.email }, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });

const publicUser = (user) => {
  if (!user) return null;
  const json = user.toJSON();
  return {
    id: json.id,
    email: json.email,
    name: json.name,
    phone: json.phone,
    avatarUrl: json.avatarUrl,
    gender: json.gender,
    dob: json.dob,
    addressLine: json.addressLine,
    city: json.city,
    state: json.state,
    country: json.country,
    pincode: json.pincode,
    isProfileComplete: !!json.isProfileComplete,
    referralCode: json.referralCode,
    walletBalancePaise: json.walletBalancePaise || 0,
  };
};

const generateReferralCode = async () => {
  // 8-char URL-safe code. Retry on the (very rare) collision.
  for (let i = 0; i < 6; i++) {
    const code = crypto.randomBytes(5).toString('base64').replace(/[+/=]/g, '').slice(0, 8).toUpperCase();
    const exists = await User.findOne({ where: { referralCode: code } });
    if (!exists) return code;
  }
  return `R${Date.now().toString(36).toUpperCase()}`;
};

// POST /api/user-auth/request-otp { email }
const requestOtp = asyncHandler(async (req, res) => {
  const email = normalize(req.body.email);
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return fail(res, 'Please provide a valid email address', 400);
  }

  // Demo account: never send a real email, just let the app move to the OTP
  // screen. The fixed code is accepted in verifyOtp below.
  if (isDemo(email)) {
    return ok(res, { email, isNewUser: false, expiresInMinutes: 10, emailDelivered: true },
      'OTP sent — use the demo code to sign in');
  }

  const existing = await User.findOne({ where: { email } });
  const isNewUser = !existing || !existing.isProfileComplete;

  const code = await issueOtp({
    email,
    purpose: 'login_signup',
    ipAddress: req.ip,
  });

  // Dev convenience: print the OTP to the SERVER console (never the API
  // response) so local testing isn't blocked when you can't read the target
  // inbox. Gated on NODE_ENV so production never logs codes.
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[user-auth][DEV] OTP for ${email}: ${code}`);
  }

  // Send the code by email. The plaintext code is NEVER returned to the client
  // (a leaked code would defeat the whole point of 2-factor email verification).
  // If Brevo can't deliver, fail loudly so the issue is visible and fixed —
  // in development we additionally log the code to the SERVER console only, so
  // local testing isn't blocked without exposing it over the API.
  const IS_DEV = process.env.NODE_ENV !== 'production';
  try {
    await sendUserOtp({ to: email, code, isNewUser });
  } catch (err) {
    console.error('[user-auth] OTP email failed:', err.message);
    if (IS_DEV) {
      console.log(`[user-auth][DEV] OTP for ${email}: ${code} (server-console only)`);
      // Let dev testing proceed to the code screen; code is in the server log.
      return ok(res, {
        email, isNewUser, expiresInMinutes: OTP_TTL_MIN, emailDelivered: false,
      }, isNewUser ? 'OTP sent — verify to create your account' : 'OTP sent — verify to sign in');
    }
    // Temporary diagnostics: set MAIL_DEBUG=true in .env to surface the real
    // SMTP error in the response (then remove it once email works).
    const msg = process.env.MAIL_DEBUG === 'true'
      ? `MAIL ERROR: ${err.message}`
      : 'Could not send the verification email. Please try again shortly.';
    return fail(res, msg, 502);
  }

  return ok(res, {
    email,
    isNewUser,
    expiresInMinutes: OTP_TTL_MIN,
    emailDelivered: true,
  }, isNewUser ? 'OTP sent — verify to create your account' : 'OTP sent — verify to sign in');
});

// POST /api/user-auth/resend-otp { email }
const resendOtp = requestOtp; // identical behaviour — issueOtp consumes the prior one

// POST /api/user-auth/verify-otp { email, code }
const verifyOtpCtrl = asyncHandler(async (req, res) => {
  const email = normalize(req.body.email);
  const code = String(req.body.code || '').trim();
  if (!email || !code) return fail(res, 'Email and code are required', 400);

  // Demo account bypass — accept the fixed code, skip the OTP store entirely.
  const result = (isDemo(email) && code === DEMO_CODE)
    ? { ok: true }
    : await verifyOtp({ email, purpose: 'login_signup', code });
  if (!result.ok) {
    const messages = {
      expired: 'This code has expired. Please request a new one.',
      too_many_attempts: 'Too many attempts. Please request a new code.',
      invalid: 'Incorrect code. Please try again.',
    };
    return fail(res, messages[result.reason] || 'Verification failed', 400);
  }

  let user = await User.findOne({ where: { email } });
  let didCreate = false;
  if (!user) {
    user = await User.create({ email, isProfileComplete: false });
    didCreate = true;
  }

  // Demo account is pre-completed so it lands straight on Home for UI review.
  if (isDemo(email) && !user.isProfileComplete) {
    user.name = user.name || 'Demo Explorer';
    user.phone = user.phone || '9999999999';
    user.isProfileComplete = true;
  }

  user.lastLoginAt = new Date();
  await user.save();

  const token = issueAuthToken(user);
  const needsProfile = !user.isProfileComplete;

  return ok(res, {
    token,
    user: publicUser(user),
    needsProfile,
    isNewUser: didCreate || needsProfile,
  }, needsProfile ? 'Verified — please complete your profile' : 'Welcome back!');
});

// POST /api/user-auth/complete-profile { name, phone, referralCode? }   (auth required)
const completeProfile = asyncHandler(async (req, res) => {
  const user = req.user;
  const name = String(req.body.name || '').trim();
  const phone = String(req.body.phone || '').trim();
  const referralCode = String(req.body.referralCode || '').trim().toUpperCase();

  if (!name) return fail(res, 'Name is required', 400);
  if (!phone) return fail(res, 'Phone is required', 400);

  // Reject anything Cashfree won't accept on the booking checkout — catching
  // this here means the user can never reach the checkout page with a phone
  // that's destined to fail at the payment gateway.
  const normalized = normalizePhone(phone);
  if (!normalized) {
    return fail(res, 'Please enter a valid 10-digit mobile number (or include the country code).', 400);
  }

  user.name = name;
  user.phone = normalized;

  // First-time profile completion — issue a referral code, link the referrer
  // if a valid code was supplied, and capture a handle to the referrer so we
  // can issue the welcome+thank-you coupons AFTER save.
  let referrerForBonus = null;
  const isFirstCompletion = !user.isProfileComplete;
  if (isFirstCompletion) {
    if (!user.referralCode) {
      user.referralCode = await generateReferralCode();
    }
    if (referralCode && referralCode !== user.referralCode) {
      const referrer = await User.findOne({ where: { referralCode } });
      if (referrer && referrer.id !== user.id) {
        user.referredByUserId = referrer.id;
        referrerForBonus = referrer;
      }
    }
    user.isProfileComplete = true;
  }

  await user.save();

  // Welcome email is fire-and-forget — never block profile completion if Brevo
  // hiccups; just log and move on.
  sendUserWelcome({ to: user.email, name: user.name }).catch((err) => {
    console.error('[user-auth] Welcome email failed:', err.message);
  });

  // v3: the moment a referee completes their profile (first login as a
  // real account) the referrer earns the reward. Fire-and-forget so a
  // payout hiccup never blocks profile save.
  if (isFirstCompletion && referrerForBonus) {
    creditReferrerForFirstLogin({ user }).catch((err) => {
      console.error('[refer-earn] first-login payout failed:', err.message);
    });
  }

  return ok(res, { user: publicUser(user) }, 'Profile saved');
});

// GET /api/user-auth/me   (auth required)
const me = asyncHandler(async (req, res) => {
  return ok(res, { user: publicUser(req.user) });
});

// PATCH /api/user-auth/profile  (auth required) — edit any of the optional
// profile fields. The bare essentials (email) are immutable here.
const updateProfile = asyncHandler(async (req, res) => {
  const user = req.user;
  const allowed = ['name', 'phone', 'avatarUrl', 'gender', 'dob', 'addressLine', 'city', 'state', 'country', 'pincode'];

  for (const key of allowed) {
    if (key in req.body) {
      const value = req.body[key];
      // Phone gets normalized the same way completeProfile does so future
      // checkouts don't trip Cashfree's phone validator.
      if (key === 'phone' && value && String(value).trim()) {
        const normalized = normalizePhone(value);
        if (!normalized) {
          return fail(res, 'Please enter a valid 10-digit mobile number (or include the country code).', 400);
        }
        user.phone = normalized;
      } else {
        user[key] = value === '' ? null : value;
      }
    }
  }
  await user.save();
  return ok(res, { user: publicUser(user) }, 'Profile updated');
});

module.exports = {
  requestOtp,
  resendOtp,
  verifyOtp: verifyOtpCtrl,
  completeProfile,
  me,
  updateProfile,
};
