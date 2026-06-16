const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const { OtpToken } = require('../models');
const { sendOtp } = require('./mailer');

const OTP_TTL_MIN = parseInt(process.env.PWA_OTP_TTL_MIN || '10', 10);
const OTP_MAX_ATTEMPTS = 5;
const IS_DEV = process.env.NODE_ENV !== 'production';

const generateCode = () => String(Math.floor(100000 + Math.random() * 900000));

// Wrap mailer.sendOtp so a Brevo failure doesn't break the flow during
// local development. In dev we log the code prominently so the dev can
// copy it from the server console; in production we re-throw so the
// caller still surfaces an error.
//
// Set PWA_OTP_STRICT=true to override the dev fallback and require email
// delivery even in dev — useful when you actually want to test Brevo
// integration end-to-end.
const STRICT_OTP = process.env.PWA_OTP_STRICT === 'true';

const dispatchOtp = async ({ email, code, purpose, role }) => {
  try {
    await sendOtp({ to: email, code, purpose, role });
    return { delivered: true, devCode: null, error: null };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[OTP] email send failed for ${email}: ${err.message}`);
    if (IS_DEV && !STRICT_OTP) {
      // eslint-disable-next-line no-console
      console.log('\n========================================');
      // eslint-disable-next-line no-console
      console.log(`[OTP DEV FALLBACK] ${role || 'user'} · ${purpose}`);
      // eslint-disable-next-line no-console
      console.log(`  email : ${email}`);
      // eslint-disable-next-line no-console
      console.log(`  code  : ${code}`);
      // eslint-disable-next-line no-console
      console.log(`  reason: ${err.message}`);
      // eslint-disable-next-line no-console
      console.log('========================================\n');
      return { delivered: false, devCode: code, error: err.message };
    }
    throw err;
  }
};

// Issue a fresh OTP for (email, target, purpose). Any unconsumed prior token
// for the same triple is consumed silently so the most recent code wins.
const issueOtp = async ({ email, target, purpose, propertyCode = null, ipAddress = null }) => {
  const normalized = email.toLowerCase().trim();
  const code = generateCode();
  const codeHash = await bcrypt.hash(code, 8);
  const expiresAt = new Date(Date.now() + OTP_TTL_MIN * 60 * 1000);

  await OtpToken.update(
    { consumedAt: new Date() },
    {
      where: {
        email: normalized,
        target,
        purpose,
        consumedAt: null,
      },
    }
  );

  await OtpToken.create({
    email: normalized,
    target,
    purpose,
    propertyCode,
    codeHash,
    expiresAt,
    ipAddress,
  });

  return code;
};

const verifyOtp = async ({ email, target, purpose, code, propertyCode = null }) => {
  const normalized = email.toLowerCase().trim();
  const token = await OtpToken.findOne({
    where: {
      email: normalized,
      target,
      purpose,
      consumedAt: null,
      expiresAt: { [Op.gt]: new Date() },
      ...(propertyCode ? { propertyCode } : {}),
    },
    order: [['createdAt', 'DESC']],
  });

  if (!token) return { ok: false, reason: 'expired' };

  if (token.attempts >= OTP_MAX_ATTEMPTS) {
    return { ok: false, reason: 'too_many_attempts' };
  }

  const matches = await bcrypt.compare(String(code), token.codeHash);
  if (!matches) {
    token.attempts += 1;
    await token.save();
    return { ok: false, reason: 'invalid' };
  }

  token.consumedAt = new Date();
  await token.save();
  return { ok: true };
};

module.exports = { issueOtp, verifyOtp, dispatchOtp, OTP_TTL_MIN, IS_DEV };
