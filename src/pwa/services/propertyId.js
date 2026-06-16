const { Property } = require('../models');

// Unique, human-readable property ID. Format: RTV-XXXXXXXX where the suffix
// is base32-ish using an alphabet that drops visually-confusable characters
// (no 0/O/1/I/L). Collision rate at 100k properties is < 1 in 10M, but we
// loop just in case.

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const randomCode = (len = 8) => {
  let s = '';
  for (let i = 0; i < len; i++) {
    s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return s;
};

const generatePropertyCode = async () => {
  for (let i = 0; i < 10; i++) {
    const code = `RTV-${randomCode(8)}`;
    const existing = await Property.findOne({ where: { propertyCode: code } });
    if (!existing) return code;
  }
  throw new Error('Failed to generate a unique propertyCode after 10 attempts');
};

module.exports = { generatePropertyCode };
