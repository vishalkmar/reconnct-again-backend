const { send } = require('../pwa/services/mailer');
const {
  Supplier, TeamMember, User, Experience,
} = require('../models');
const {
  escapeHtml: escape, emailShell, kvTable, ctaButton, calloutBox,
} = require('../utils/emailLayout');

/*
  Email side of the onboarding review pipeline.

  reviewNotify.service handles the IN-APP feed + sockets; this is the parallel
  outbound layer, so nobody has to be looking at a dashboard to learn their
  turn has come. Every function here is best-effort: a failed mail must never
  roll back the review action that triggered it, so callers `.catch()` and the
  pipeline carries on.
*/

const TEAM_PORTAL_URL = process.env.TEAM_PORTAL_URL || 'https://reconnct-again-frontend.vercel.app/team/login';
const SUPPLIER_PORTAL_URL = process.env.SUPPLIER_PORTAL_URL || 'https://reconnct-again-frontend.vercel.app/supplier/login';

// Who submitted this experience → where a decision email should land.
// BD-submitted goes to that BD; a supplier's own submission goes to them.
const submitterContact = async (exp) => {
  if (!exp) return null;
  if (exp.createdByTeamMemberId) {
    const m = await TeamMember.findByPk(exp.createdByTeamMemberId, { attributes: ['id', 'name', 'email'] });
    return m ? { kind: 'bd', email: m.email, name: m.name } : null;
  }
  if (exp.ownerUserId) {
    const u = await User.findByPk(exp.ownerUserId, { attributes: ['id', 'name', 'email'] });
    return u ? { kind: 'host', email: u.email, name: u.name } : null;
  }
  if (exp.supplierId) {
    const s = await Supplier.findByPk(exp.supplierId, { attributes: ['id', 'companyName', 'email'] });
    return s ? { kind: 'supplier', email: s.email, name: s.companyName } : null;
  }
  return null;
};

const supplierContact = async (exp) => {
  if (!exp?.supplierId) return null;
  const s = await Supplier.findByPk(exp.supplierId, { attributes: ['id', 'companyName', 'email'] });
  return s?.email ? { email: s.email, name: s.companyName } : null;
};

const copsEmails = async () => {
  const rows = await TeamMember.findAll({
    where: { roleType: 'cops', isActive: true },
    attributes: ['id', 'name', 'email'],
  });
  return rows.filter((r) => r.email);
};

// The identifying details every one of these emails carries.
const detailRows = (exp, extra = []) => kvTable([
  ['Experience', escape(exp.name || '—')],
  exp.location || exp.city ? ['Location', escape([exp.location, exp.city].filter(Boolean).join(', '))] : null,
  ['Reference', `#${exp.id}`],
  ...extra,
]);

const mail = async ({ to, subject, html, text }) => {
  if (!to) return null;
  return send({ to, subject, html, text });
};

/* ── 1. A new (or re-submitted) experience lands with Center Ops ───────── */
const notifyCopsNewSubmission = async ({ exp, resubmitted = false, via = '' }) => {
  const team = await copsEmails();
  if (!team.length) return;
  const what = resubmitted ? 're-submitted for review' : 'submitted for review';
  const html = emailShell({
    preheader: `${exp.name} was ${what}`,
    eyebrow: resubmitted ? 'Back for another look' : 'New submission',
    heading: escape(exp.name || 'New experience'),
    bodyHtml: `
      <p style="color:#374151;line-height:1.6;margin:0 0 16px;">
        An experience has been <strong>${what}</strong>${via ? ` by ${escape(via)}` : ''}.
        Please open your dashboard and complete the content review phase — section by section,
        then schedule the on-site QCOPS check.
      </p>
      ${detailRows(exp)}
      ${ctaButton(TEAM_PORTAL_URL, 'Open the review queue')}
    `,
  });
  const text = `${exp.name} was ${what}${via ? ` by ${via}` : ''}. Open the Team Portal review queue to complete the review: ${TEAM_PORTAL_URL}`;
  await Promise.all(team.map((m) => mail({ to: m.email, subject: `${resubmitted ? 'Re-submitted' : 'New submission'} for review: "${exp.name}"`, html, text })));
};

/* ── 2. A review decision goes back to whoever submitted it ────────────── */
const DECISION = {
  objection: {
    eyebrow: 'Changes needed',
    subject: (n) => `Changes needed on "${n}"`,
    lead: 'Center Ops reviewed your submission and raised some points that need fixing before it can move forward.',
  },
  approved: {
    eyebrow: 'Content approved ✅',
    subject: (n) => `"${n}" passed content review`,
    lead: 'Good news — the content review is done. Next up is the on-site quality check before it can go live.',
  },
  rejected: {
    eyebrow: 'Not approved',
    subject: (n) => `"${n}" was not approved`,
    lead: 'After review, this submission has not been approved.',
  },
  live: {
    eyebrow: 'You are live 🎉',
    subject: (n) => `"${n}" is now live`,
    lead: 'Your experience passed every check and is now published on the website and app.',
  },
};

const notifySubmitterDecision = async ({ exp, kind, note, extraRows = [] }) => {
  const to = await submitterContact(exp);
  if (!to?.email) return;
  const d = DECISION[kind];
  if (!d) return;
  const portal = to.kind === 'supplier' ? SUPPLIER_PORTAL_URL : TEAM_PORTAL_URL;
  const html = emailShell({
    preheader: d.lead,
    eyebrow: d.eyebrow,
    heading: escape(exp.name || 'Your experience'),
    bodyHtml: `
      <p style="color:#374151;line-height:1.6;margin:0 0 16px;">Hi ${escape(to.name || 'there')}, ${d.lead}</p>
      ${note ? calloutBox(kind === 'objection' ? 'What needs fixing' : 'Note from Center Ops', escape(note)) : ''}
      ${detailRows(exp, extraRows)}
      ${ctaButton(portal, kind === 'objection' ? 'Resolve and send back' : 'Open your dashboard')}
    `,
  });
  const text = `${d.subject(exp.name)}\n\n${d.lead}${note ? `\n\n${note}` : ''}\n\n${portal}`;
  await mail({ to: to.email, subject: d.subject(exp.name || 'your experience'), html, text });
};

/* ── 3. Content approved → QCOPS visit scheduled ───────────────────────── */

// The supplier has to physically get the place ready, so they're told first.
const notifySupplierQcVisit = async ({ exp, qc }) => {
  const to = (await supplierContact(exp)) || (await submitterContact(exp));
  if (!to?.email) return;
  const when = qc?.visitDate ? `${qc.visitDate}${qc.visitTime ? ` at ${qc.visitTime}` : ''}` : 'shortly';
  const html = emailShell({
    preheader: `${exp.name} is on its way — a team member may visit the location`,
    eyebrow: 'On the way 🚀',
    heading: escape(exp.name || 'Your experience'),
    bodyHtml: `
      <p style="color:#374151;line-height:1.6;margin:0 0 16px;">
        Hi ${escape(to.name || 'there')}, your experience has cleared content review and is on its way to going live.
      </p>
      <p style="color:#374151;line-height:1.6;margin:0 0 16px;">
        <strong>A member of our quality team may visit the location</strong> to verify it in person.
        Please make sure everything is in good order — the space, the facilities and anything listed
        in your experience — so the visit goes smoothly.
      </p>
      ${calloutBox('Expected visit', escape(when))}
      ${detailRows(exp, qc?.instructions ? [['What they will check', escape(qc.instructions)]] : [])}
      ${ctaButton(SUPPLIER_PORTAL_URL, 'View your listing')}
    `,
  });
  const text = `${exp.name} is on its way to going live. A member of our quality team may visit the location (${when}) to verify it — please keep everything in good order.`;
  await mail({ to: to.email, subject: `Get ready — a quality visit is coming for "${exp.name}"`, html, text });
};

// And the assigned QCOPS is told to go do it.
const notifyQcopsAssignment = async ({ exp, qcopsId, qc }) => {
  if (!qcopsId) return;
  const m = await TeamMember.findByPk(qcopsId, { attributes: ['id', 'name', 'email'] });
  if (!m?.email) return;
  const when = qc?.visitDate ? `${qc.visitDate}${qc.visitTime ? ` at ${qc.visitTime}` : ''}` : 'TBC';
  const html = emailShell({
    preheader: `On-site check assigned: ${exp.name}`,
    eyebrow: 'On-site check assigned',
    heading: escape(exp.name || 'Experience'),
    bodyHtml: `
      <p style="color:#374151;line-height:1.6;margin:0 0 16px;">
        Hi ${escape(m.name || 'there')}, an on-site quality check has been assigned to you.
        Please open your dashboard to acknowledge it, confirm when you're on-site, and submit your
        feedback so the listing can move to the next step.
      </p>
      ${calloutBox('Your visit', escape(when))}
      ${detailRows(exp, qc?.instructions ? [['Instructions', escape(qc.instructions)]] : [])}
      ${ctaButton(TEAM_PORTAL_URL, 'Open My QC Visits')}
    `,
  });
  const text = `On-site check assigned: ${exp.name} (${when}). Open your dashboard to acknowledge and submit feedback: ${TEAM_PORTAL_URL}`;
  await mail({ to: m.email, subject: `On-site check assigned: "${exp.name}"`, html, text });
};

/* ── 4. QCOPS submitted feedback → Center Ops + the submitter ──────────── */
const REC_LABEL = {
  approved: 'Approved',
  approved_minor: 'Approved — minor changes requested',
  approved_major: 'Approved — major changes requested',
};

const notifyQcFeedback = async ({ exp, feedback, qcopsName }) => {
  const status = REC_LABEL[feedback?.recommendation] || feedback?.recommendation || 'Feedback submitted';
  const rows = [
    ['Outcome', escape(status)],
    feedback?.overallRating ? ['Overall rating', `${feedback.overallRating}/5`] : null,
    feedback?.changeDetails ? ['What they asked for', escape(feedback.changeDetails)] : null,
    qcopsName ? ['Checked by', escape(qcopsName)] : null,
  ].filter(Boolean);

  const build = (lead, portal) => emailShell({
    preheader: `${exp.name} — on-site check: ${status}`,
    eyebrow: 'On-site check complete',
    heading: escape(exp.name || 'Experience'),
    bodyHtml: `
      <p style="color:#374151;line-height:1.6;margin:0 0 16px;">${lead}</p>
      ${calloutBox('Outcome', escape(status))}
      ${detailRows(exp, rows)}
      ${ctaButton(portal, 'Open your dashboard')}
    `,
  });

  const team = await copsEmails();
  const copsHtml = build('The on-site quality check is done. Open the review queue to decide the next step.', TEAM_PORTAL_URL);
  const copsText = `${exp.name} — on-site check complete: ${status}. Open the review queue: ${TEAM_PORTAL_URL}`;
  await Promise.all(team.map((m) => mail({ to: m.email, subject: `On-site check complete: "${exp.name}" — ${status}`, html: copsHtml, text: copsText })));

  const to = await submitterContact(exp);
  if (to?.email) {
    const portal = to.kind === 'supplier' ? SUPPLIER_PORTAL_URL : TEAM_PORTAL_URL;
    await mail({
      to: to.email,
      subject: `On-site check complete: "${exp.name}" — ${status}`,
      html: build(`Hi ${escape(to.name || 'there')}, the on-site quality check on your experience is done.`, portal),
      text: `${exp.name} — on-site check complete: ${status}. ${portal}`,
    });
  }
};

/* ── A supplier is assigned to a Key Account Manager ──────────────────── */
const notifyAmAssigned = async ({ manager, supplier }) => {
  if (!manager?.email) return;
  const html = emailShell({
    preheader: `${supplier.companyName || 'A supplier'} is now assigned to you`,
    eyebrow: 'New supplier assigned',
    heading: escape(supplier.companyName || 'New supplier'),
    bodyHtml: `
      <p style="color:#374151;line-height:1.6;margin:0 0 16px;">
        Hi ${escape(manager.name || 'there')}, a supplier has just been assigned to you to guide and look after.
      </p>
      ${kvTable([
    ['Company', escape(supplier.companyName || '—')],
    supplier.supplierName ? ['Contact', escape(supplier.supplierName)] : null,
    supplier.email ? ['Email', escape(supplier.email)] : null,
    supplier.phone ? ['Phone', escape(supplier.phone)] : null,
  ])}
      ${ctaButton(`${TEAM_PORTAL_URL.replace('/login', '')}/my-suppliers`, 'Open Assigned Suppliers')}
    `,
  });
  const text = `New supplier assigned to you: ${supplier.companyName || ''} (${supplier.email || ''}). Open your Assigned Suppliers in the Team Portal.`;
  await mail({ to: manager.email, subject: `New supplier assigned: "${supplier.companyName || 'supplier'}"`, html, text });
};

/*
  Tell the two staff who look after a SUPPLIER — their Key Account Manager and
  the BD who onboarded them — about something on that supplier's OWN listing
  (a new experience, or a review decision). Both get an email AND an in-app
  bell notification. No-op unless the experience was supplier-submitted.
*/
const notifySupplierStakeholders = async (exp, { eyebrow, title, lead, subject, kind, extraRows = [] }) => {
  if (!exp?.supplierId || exp.createdByTeamMemberId) return;
  const supplier = await Supplier.findByPk(exp.supplierId, {
    attributes: ['id', 'companyName', 'accountManagerId', 'createdByTeamMemberId'],
  });
  if (!supplier) return;
  const staffIds = [...new Set([supplier.accountManagerId, supplier.createdByTeamMemberId].filter(Boolean))];
  if (!staffIds.length) return;
  const staff = await TeamMember.findAll({ where: { id: staffIds, isActive: true }, attributes: ['id', 'name', 'email'] });

  // eslint-disable-next-line global-require
  const reviewNotify = require('./reviewNotify.service');
  const html = emailShell({
    preheader: lead.replace(/<[^>]+>/g, ''),
    eyebrow,
    heading: escape(exp.name || 'Experience'),
    bodyHtml: `
      <p style="color:#374151;line-height:1.6;margin:0 0 16px;">${lead}</p>
      ${detailRows(exp, [['Supplier', escape(supplier.companyName || '—')], ...extraRows])}
      ${ctaButton(TEAM_PORTAL_URL.replace('/login', '') + '/my-suppliers', 'Open your suppliers')}
    `,
  });
  const text = `${lead.replace(/<[^>]+>/g, '')} — ${exp.name} (${supplier.companyName || 'supplier'}).`;
  await Promise.all(staff.map(async (m) => {
    if (m.email) await mail({ to: m.email, subject, html, text });
    reviewNotify.notify({
      recipientType: 'team', recipientId: m.id, experienceId: exp.id,
      kind, title, message: `${exp.name} — ${supplier.companyName || 'your supplier'}`,
      meta: { experienceName: exp.name, supplierId: supplier.id },
    }).catch(() => {});
  }));
};

const notifySupplierStakeholdersOfExperience = (exp) => notifySupplierStakeholders(exp, {
  eyebrow: 'New experience from your supplier',
  title: 'New experience from your supplier',
  lead: `<strong>${escape((exp && exp.name) || 'A new experience')}</strong> was just added by a supplier you look after and is entering review.`,
  subject: `New experience from your supplier: "${exp && exp.name}"`,
  kind: 'supplier_new_experience',
});

const DECISION_STAKEHOLDER = {
  objection: { eyebrow: 'Changes requested', verb: 'needs changes after review' },
  approved: { eyebrow: 'Content approved', verb: 'passed content review' },
  rejected: { eyebrow: 'Not approved', verb: 'was not approved' },
  live: { eyebrow: 'Now live', verb: 'is now live' },
};
const notifySupplierStakeholdersOfDecision = (exp, kind, note) => {
  const d = DECISION_STAKEHOLDER[kind];
  if (!d) return Promise.resolve();
  return notifySupplierStakeholders(exp, {
    eyebrow: d.eyebrow,
    title: `Your supplier's listing ${d.verb}`,
    lead: `A listing from a supplier you look after <strong>${escape(d.verb)}</strong>.`,
    subject: `Update on "${exp && exp.name}" — ${d.eyebrow}`,
    kind: `supplier_listing_${kind}`,
    extraRows: note ? [['Note', escape(note)]] : [],
  });
};

/* ── Supplier: changes accepted on your behalf, here's the deadline ───── */
const notifySupplierChangeDeadline = async ({ exp, deadline, details }) => {
  const to = await supplierContact(exp);
  if (!to?.email) return;
  const html = emailShell({
    preheader: `Action needed on ${exp.name}${deadline ? ` by ${deadline}` : ''}`,
    eyebrow: 'Action needed ⏳',
    heading: escape(exp.name || 'Your experience'),
    bodyHtml: `
      <p style="color:#374151;line-height:1.6;margin:0 0 16px;">
        Hi ${escape(to.name || 'there')}, some changes were requested on your listing after the on-site check,
        and they've been accepted on your behalf. Please get them done${deadline ? ` by the agreed deadline` : ''}.
      </p>
      ${deadline ? calloutBox('Complete by', escape(deadline)) : ''}
      ${detailRows(exp, details ? [['What to change', escape(details)]] : [])}
      ${ctaButton(SUPPLIER_PORTAL_URL, 'Open your Supplier Portal')}
    `,
  });
  const text = `Action needed on ${exp.name}${deadline ? ` by ${deadline}` : ''}. ${details || 'Changes were requested after the on-site check.'}`;
  await mail({ to: to.email, subject: `Action needed on "${exp.name}"${deadline ? ` by ${deadline}` : ''}`, html, text });
};

/* ── The QCOPS who checked a listing is told it went live ─────────────── */
const notifyQcopsWentLive = async ({ exp }) => {
  if (!exp?.qcopsTeamMemberId) return;
  const m = await TeamMember.findByPk(exp.qcopsTeamMemberId, { attributes: ['id', 'name', 'email'] });
  if (!m?.email) return;
  const html = emailShell({
    preheader: `${exp.name} is now live`,
    eyebrow: 'Now live 🎉',
    heading: escape(exp.name || 'Experience'),
    bodyHtml: `
      <p style="color:#374151;line-height:1.6;margin:0 0 16px;">
        Hi ${escape(m.name || 'there')}, a listing you checked on-site has passed and is now published on the
        website and app.
      </p>
      ${detailRows(exp)}
      ${ctaButton(TEAM_PORTAL_URL.replace('/login', '') + '/qc-visits', 'Open My QC Visits')}
    `,
  });
  const text = `A listing you checked is now live: ${exp.name}.`;
  await mail({ to: m.email, subject: `Now live: "${exp.name}"`, html, text });
};

/* ── The supplier is told who their Key Account Manager is ────────────── */
const notifySupplierOfManager = async ({ supplier, manager }) => {
  if (!supplier?.email || !manager) return;
  const html = emailShell({
    preheader: `${manager.name} is your Key Account Manager at reconnct`,
    eyebrow: 'Your account manager 🤝',
    heading: `Meet ${escape(manager.name || 'your manager')}`,
    bodyHtml: `
      <p style="color:#374151;line-height:1.6;margin:0 0 16px;">
        Hi ${escape(supplier.companyName || 'there')}, you've been paired with a Key Account Manager who's here to
        help you with your listings, bookings and payouts. Reach out any time.
      </p>
      ${kvTable([
    ['Manager', escape(manager.name || '—')],
    manager.email ? ['Email', escape(manager.email)] : null,
    manager.employeeCode ? ['Ref', escape(manager.employeeCode)] : null,
  ])}
      ${ctaButton(SUPPLIER_PORTAL_URL, 'Open your Supplier Portal')}
    `,
  });
  const text = `Your Key Account Manager at reconnct is ${manager.name}${manager.email ? ` (${manager.email})` : ''}. Reach out any time for help with your listings, bookings and payouts.`;
  await mail({ to: supplier.email, subject: 'Meet your reconnct account manager', html, text });
};

module.exports = {
  submitterContact,
  supplierContact,
  notifyCopsNewSubmission,
  notifyAmAssigned,
  notifySupplierOfManager,
  notifySupplierStakeholdersOfExperience,
  notifySupplierStakeholdersOfDecision,
  notifyQcopsWentLive,
  notifySupplierChangeDeadline,
  notifySubmitterDecision,
  notifySupplierQcVisit,
  notifyQcopsAssignment,
  notifyQcFeedback,
  TEAM_PORTAL_URL,
  SUPPLIER_PORTAL_URL,
};
