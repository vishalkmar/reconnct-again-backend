const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const { UserOtpToken } = require('../models');

const OTP_TTL_MIN = parseInt(process.env.USER_OTP_TTL_MIN || process.env.PWA_OTP_TTL_MIN || '10', 10);
const OTP_MAX_ATTEMPTS = 5;

const generateCode = () => String(Math.floor(100000 + Math.random() * 900000));

const issueOtp = async ({ email, purpose = 'login_signup', ipAddress = null }) => {
  const normalized = String(email).toLowerCase().trim();
  const code = generateCode();
  const codeHash = await bcrypt.hash(code, 8);
  const expiresAt = new Date(Date.now() + OTP_TTL_MIN * 60 * 1000);

  // Consume any prior unconsumed OTPs for the same (email, purpose) so only
  // the freshest code is valid.
  await UserOtpToken.update(
    { consumedAt: new Date() },
    { where: { email: normalized, purpose, consumedAt: null } }
  );

  await UserOtpToken.create({
    email: normalized,
    purpose,
    codeHash,
    expiresAt,
    ipAddress,
  });

  return code;
};

const verifyOtp = async ({ email, purpose = 'login_signup', code }) => {
  const normalized = String(email).toLowerCase().trim();
  const token = await UserOtpToken.findOne({
    where: {
      email: normalized,
      purpose,
      consumedAt: null,
      expiresAt: { [Op.gt]: new Date() },
    },
    order: [['createdAt', 'DESC']],
  });

  if (!token) return { ok: false, reason: 'expired' };
  if (token.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, reason: 'too_many_attempts' };

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

module.exports = { issueOtp, verifyOtp, OTP_TTL_MIN };
