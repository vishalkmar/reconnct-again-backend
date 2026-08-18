/*
  Boot-time secret validation.

  The single most catastrophic misconfiguration this platform can ship with is a
  missing or guessable JWT_SECRET — every auth token is signed with it, so a
  weak/placeholder secret lets anyone forge a token for ANY account (admin
  included). This runs once at startup:

    • production  → a bad secret ABORTS the boot (better a failed deploy than a
                    silently forgeable one).
    • development → loud warning, keeps running so local work isn't blocked.

  Purely a guard: it validates config, it does not change any behaviour when the
  config is already sound.
*/

const PLACEHOLDER = /secret|change|example|your[-_]?|placeholder|xxxx|todo|123456|password|default/i;
const MIN_LEN = 32;

const checkJwtSecret = () => {
  const s = process.env.JWT_SECRET || '';
  const problems = [];
  if (!s) problems.push('JWT_SECRET is not set');
  else {
    if (s.length < MIN_LEN) problems.push(`JWT_SECRET is only ${s.length} chars — use at least ${MIN_LEN}`);
    if (PLACEHOLDER.test(s)) problems.push('JWT_SECRET looks like a placeholder/default (contains words like "secret"/"change") — replace it with a random value');
    if (new Set(s).size < 12) problems.push('JWT_SECRET has very low character variety — generate a random one');
  }
  return problems;
};

const runSecurityChecks = () => {
  const isProd = process.env.NODE_ENV === 'production';
  const problems = checkJwtSecret();

  if (problems.length === 0) return;

  const banner = '═'.repeat(64);
  const lines = [
    banner,
    '  SECURITY: weak configuration detected',
    ...problems.map((p) => `   • ${p}`),
    '',
    '  Generate a strong secret with:',
    "     node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"",
    '  then set JWT_SECRET in your .env and restart.',
    '  (Rotating JWT_SECRET signs everyone out once — expected & safe.)',
    banner,
  ];
  const text = lines.join('\n');

  if (isProd) {
    // Fail the boot — never run production with a forgeable token secret.
    console.error(`\n${text}\n`);
    throw new Error('Refusing to start in production with an insecure JWT_SECRET. Fix the config above.');
  }
  // Dev: warn loudly but keep going.
  console.warn(`\n${text}\n`);
};

module.exports = { runSecurityChecks, checkJwtSecret };
