const { VoiceCallLog } = require('../models');

/*
  Voice-call dispatch — currently a STUB. We don't have a Twilio / Exotel
  account yet, but the surface area the rest of the codebase calls is the
  real shape, so swapping in a provider later is a single-file change.

  For every "call" we:
    1. Insert a `pwa_voice_call_logs` row with role, phone, script, status.
    2. console.log a one-line summary so it's visible in the dev console
       that the system *would* have called.

  When a real provider is wired in, replace `placeCall` with the API call
  and set `providerSid` / `status` from the response.
*/

const buildScript = ({ recipientRole, leadCustomerName, leadDate, packageName }) => {
  if (recipientRole === 'owner') {
    return [
      `Hello, this is an automated voice call from Retreats by Traveon.`,
      `A new check-availability enquiry has come in for ${packageName} from ${leadCustomerName} for the date ${leadDate}.`,
      `Please open the PWA owner dashboard to confirm or decline this date.`,
    ].join(' ');
  }
  if (recipientRole === 'salesperson') {
    return [
      `Hello, this is an automated voice call from Retreats by Traveon sales.`,
      `A new lead has been assigned to you for ${packageName} from ${leadCustomerName} for the date ${leadDate}.`,
      `Please open your dashboard to start working the lead.`,
    ].join(' ');
  }
  return `Automated call from Retreats by Traveon.`;
};

const placeCall = async ({
  leadId,
  recipientRole,    // 'owner' | 'salesperson' | 'customer'
  recipientPhone,
  recipientName,
  packageName,
  leadCustomerName,
  leadDate,
}) => {
  if (!recipientPhone) {
    return null;
  }
  const scriptText = buildScript({
    recipientRole,
    leadCustomerName,
    leadDate,
    packageName,
  });

  // Log — real provider call goes here later.
  try {
    const row = await VoiceCallLog.create({
      leadId: leadId || null,
      recipientRole,
      recipientPhone,
      recipientName: recipientName || null,
      scriptText,
      status: 'queued',
      provider: 'dummy',
    });
    // eslint-disable-next-line no-console
    console.log(`[VOICE] queued dummy call to ${recipientRole} ${recipientPhone} — lead ${leadId}`);
    return row;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[VOICE] could not log dummy call:', err.message);
    return null;
  }
};

module.exports = { placeCall, buildScript };
