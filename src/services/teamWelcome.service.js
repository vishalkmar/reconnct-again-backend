const { send } = require('../pwa/services/mailer');
const { generatePassword } = require('./supplierWelcome.service');
const { ROLE_LABELS } = require('../models/teamMember.model');
const {
  escapeHtml: escape, emailShell, kvTable, ctaButton, calloutBox,
} = require('../utils/emailLayout');

/*
  Welcome email for an internal staff account (BD / COPS / QCOPS / Account
  Manager / CSM / Marketing). Mirrors the supplier welcome, EXCEPT these roles
  are web-only — so the email carries the Team Portal link, never an app link.

  The password is generated here (never chosen by the admin) and only ever
  appears in this email.
*/
const TEAM_PORTAL_URL = process.env.TEAM_PORTAL_URL || 'https://reconnct-again-frontend.vercel.app/team/login';

const sendTeamWelcome = async ({ member, password }) => {
  if (!member?.email || !password) return;
  const roleLabel = ROLE_LABELS[member.roleType] || member.roleType;

  const html = emailShell({
    preheader: `Your reconnct ${roleLabel} account is ready — sign in with ${member.email}`,
    eyebrow: 'Welcome to the reconnct team 🎉',
    heading: `You're all set, ${escape(member.name || 'there')}`,
    bodyHtml: `
      <p style="color:#374151;line-height:1.6;margin:0 0 16px;">
        Congratulations — your <strong>${escape(roleLabel)}</strong> account has been created.
        Sign in to the Team Portal to get started.
      </p>
      ${calloutBox('Your password', `<span style="font-family:monospace;letter-spacing:1px;">${escape(password)}</span>`, 'Please change it after your first sign-in')}
      ${kvTable([
    ['Email', escape(member.email)],
    ['Password', `<span style="font-family:monospace;">${escape(password)}</span>`],
    ['Role', escape(roleLabel)],
    member.employeeCode ? ['Employee code', escape(member.employeeCode)] : null,
  ])}
      ${ctaButton(TEAM_PORTAL_URL, 'Open the Team Portal')}
      <p style="color:#6B7280;line-height:1.6;font-size:12px;margin:20px 0 0;">
        Keep this email safe — it's the only place your password is shown. If you didn't expect this,
        just reply and let us know.
      </p>
    `,
  });

  const text = [
    `Welcome to the reconnct team, ${member.name || ''}!`,
    '',
    `Your ${roleLabel} account has been created.`,
    `Email: ${member.email}`,
    `Password: ${password}`,
    member.employeeCode ? `Employee code: ${member.employeeCode}` : '',
    '',
    `Team Portal: ${TEAM_PORTAL_URL}`,
    '',
    'Please change your password after signing in.',
  ].filter(Boolean).join('\n');

  return send({ to: member.email, subject: `Welcome to reconnct — your ${roleLabel} account is ready`, html, text });
};

module.exports = { generatePassword, sendTeamWelcome, TEAM_PORTAL_URL };
