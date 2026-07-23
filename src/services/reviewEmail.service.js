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
// Public site + app — the direct links a "went live" email points guests/owners to.
const PUBLIC_WEB_URL = process.env.PUBLIC_WEB_URL || 'https://reconnct-again-frontend.vercel.app';
const APP_URL = process.env.APP_DOWNLOAD_URL || 'https://reconnct.app/app';
const experienceLink = (exp) => `${PUBLIC_WEB_URL}/experiences/${exp.slug || exp.id}`;

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
const notifySupplierQcVisit = async ({ exp }) => {
  const to = (await supplierContact(exp)) || (await submitterContact(exp));
  if (!to?.email) return;
  const html = emailShell({
    preheader: `${exp.name} is on its way — our quality team will coordinate a visit`,
    eyebrow: 'On the way 🚀',
    heading: escape(exp.name || 'Your experience'),
    bodyHtml: `
      <p style="color:#374151;line-height:1.6;margin:0 0 16px;">
        Hi ${escape(to.name || 'there')}, your experience has cleared content review and is on its way to going live.
      </p>
      <p style="color:#374151;line-height:1.6;margin:0 0 16px;">
        <strong>A member of our quality team will get in touch to arrange an on-site visit</strong>, usually within
        24–48 hours, to verify it in person. Please keep everything in good order — the space, the facilities and
        anything listed — and be ready to confirm a convenient time when they reach out.
      </p>
      ${detailRows(exp)}
      ${ctaButton(SUPPLIER_PORTAL_URL, 'View your listing')}
    `,
  });
  const text = `${exp.name} is on its way to going live. Our quality team will contact you within 24–48 hours to arrange an on-site visit — please keep everything in good order and be ready to confirm a time.`;
  await mail({ to: to.email, subject: `Get ready — a quality visit is coming for "${exp.name}"`, html, text });
};

// And the assigned QCOPS is told to go do it.
const notifyQcopsAssignment = async ({ exp, qcopsId, qc }) => {
  if (!qcopsId) return;
  const m = await TeamMember.findByPk(qcopsId, { attributes: ['id', 'name', 'email'] });
  if (!m?.email) return;

  // Full supplier + site details so QCOPS can coordinate the timing directly.
  const sup = exp.supplierId ? await Supplier.findByPk(exp.supplierId, { attributes: ['companyName', 'supplierName', 'email', 'phone'] }) : null;
  const siteAddress = [exp.location, exp.nearbyLocation, exp.city].filter(Boolean).join(', ');
  const heading = qc?.turnaroundHeading || 'Turnaround time';
  const note = qc?.turnaroundNote || 'Turnaround time for the Quality check is 24 to 48 hrs. Coordinate with the supplier for their availability.';

  const supplierRows = [
    sup?.companyName ? ['Supplier', escape(sup.companyName)] : null,
    sup?.supplierName ? ['Contact person', escape(sup.supplierName)] : null,
    sup?.phone ? ['Phone', escape(sup.phone)] : null,
    sup?.email ? ['Email', escape(sup.email)] : null,
    siteAddress ? ['Site address', escape(siteAddress)] : null,
  ];

  const html = emailShell({
    preheader: `On-site check assigned: ${exp.name}`,
    eyebrow: 'On-site check assigned',
    heading: escape(exp.name || 'Experience'),
    bodyHtml: `
      <p style="color:#374151;line-height:1.6;margin:0 0 16px;">
        Hi ${escape(m.name || 'there')}, an on-site quality check has been assigned to you.
      </p>
      ${calloutBox(escape(heading), escape(note))}
      <p style="color:#374151;line-height:1.6;margin:16px 0 6px;font-weight:700;">Supplier details — coordinate the visit timing with them</p>
      ${kvTable(supplierRows)}
      <p style="color:#374151;line-height:1.6;margin:18px 0 6px;">
        Once you've agreed a time, open your dashboard and <strong>send your acknowledgement with your schedule of visit</strong>.
      </p>
      ${detailRows(exp)}
      ${ctaButton(TEAM_PORTAL_URL.replace('/login', '') + '/qc-visits', 'Open My QC Visits')}
    `,
  });
  const text = `On-site check assigned: ${exp.name}. ${heading}: ${note}\nSupplier: ${sup?.companyName || '—'}${sup?.phone ? ` · ${sup.phone}` : ''}${sup?.email ? ` · ${sup.email}` : ''}${siteAddress ? `\nSite: ${siteAddress}` : ''}\nAgree a time with the supplier, then send your acknowledgement with your schedule: ${TEAM_PORTAL_URL}`;
  await mail({ to: m.email, subject: `On-site check assigned: "${exp.name}" — coordinate & schedule`, html, text });
};

// QCOPS sent back their acknowledgement + schedule → Center Ops is told when.
const notifyCopsQcSchedule = async ({ exp, qcopsName, visitDate, visitTime, note }) => {
  const copsId = exp.qcReview?.assignedByCopsId;
  if (!copsId) return;
  const m = await TeamMember.findByPk(copsId, { attributes: ['id', 'name', 'email'] });
  if (!m?.email) return;
  const when = `${visitDate}${visitTime ? ` at ${visitTime}` : ''}`;
  const html = emailShell({
    preheader: `${qcopsName} scheduled the QC visit for ${exp.name}`,
    eyebrow: 'QC visit scheduled',
    heading: escape(exp.name || 'Experience'),
    bodyHtml: `
      <p style="color:#374151;line-height:1.6;margin:0 0 16px;">
        ${escape(qcopsName || 'QCOPS')} has acknowledged the on-site check and set a visit time.
      </p>
      ${calloutBox('Scheduled visit', escape(when))}
      ${detailRows(exp, note ? [['QCOPS note', escape(note)]] : [])}
      ${ctaButton(TEAM_PORTAL_URL.replace('/login', '') + '/review-queue', 'Open the review queue')}
    `,
  });
  const text = `${qcopsName} scheduled the QC visit for ${exp.name}: ${when}.${note ? ` Note: ${note}` : ''}`;
  await mail({ to: m.email, subject: `QC visit scheduled: "${exp.name}" — ${when}`, html, text });
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

/*
  A listing went LIVE — the single place that tells EVERYONE, with the right
  message and BOTH email + in-app notification each:
    • Supplier (the experience's owner) — links to see it on web + app, plus who
      their Key Account Manager is for any query.
    • Key Account Manager — one more of their supplier's experiences is live.
    • BD — only if a BD onboarded this listing.
    • Center Ops — all active COPS.
    • QCOPS — the one who ran the on-site check.
*/
const notifyWentLive = async (exp) => {
  // eslint-disable-next-line global-require
  const reviewNotify = require('./reviewNotify.service');
  const link = experienceLink(exp);
  const supplier = exp.supplierId
    ? await Supplier.findByPk(exp.supplierId, { attributes: ['id', 'companyName', 'email', 'accountManagerId'] })
    : null;
  const kam = supplier?.accountManagerId
    ? await TeamMember.findByPk(supplier.accountManagerId, { attributes: ['id', 'name', 'email'] })
    : null;

  // 1. SUPPLIER — email (links + KAM info) + in-app + push.
  if (supplier?.email) {
    const html = emailShell({
      preheader: `${exp.name} is now live on reconnct`,
      eyebrow: 'You are live 🎉',
      heading: escape(exp.name || 'Your experience'),
      bodyHtml: `
        <p style="color:#374151;line-height:1.6;margin:0 0 16px;">
          Great news — <strong>${escape(exp.name || 'your experience')}</strong> passed every check and is now published on
          the reconnct website and app. Guests can find and book it right away.
        </p>
        ${ctaButton(link, 'View it on the website')}
        ${ctaButton(APP_URL, 'Open it in the app')}
        ${kam ? `
          <p style="color:#374151;line-height:1.6;margin:20px 0 6px;font-weight:700;">Any questions? Your account manager can help</p>
          ${kvTable([['Manager', escape(kam.name || '—')], kam.email ? ['Email', escape(kam.email)] : null])}
        ` : ''}
      `,
    });
    const text = `${exp.name} is now live on reconnct.\nWebsite: ${link}\nApp: ${APP_URL}${kam ? `\nYour account manager: ${kam.name}${kam.email ? ` (${kam.email})` : ''}` : ''}`;
    await mail({ to: supplier.email, subject: `You're live: "${exp.name}" is on reconnct 🎉`, html, text });
  }
  if (supplier?.id) {
    reviewNotify.notifySupplier(supplier.id, {
      experienceId: exp.id, kind: 'live',
      title: `"${exp.name}" is now live 🎉`,
      message: 'Your experience passed every check and is published on the website and app.',
    }).catch(() => {});
  }

  // 2. KAM — email + in-app.
  if (kam) {
    if (kam.email) {
      const html = emailShell({
        preheader: `${exp.name} (${supplier?.companyName || 'your supplier'}) is now live`,
        eyebrow: 'Supplier listing live 🎉',
        heading: escape(exp.name || 'Experience'),
        bodyHtml: `
          <p style="color:#374151;line-height:1.6;margin:0 0 16px;">
            Hi ${escape(kam.name || 'there')}, one more experience from <strong>${escape(supplier?.companyName || 'your supplier')}</strong> is
            now live. Do have a look and check in with the supplier in case of any problem.
          </p>
          ${detailRows(exp, [['Supplier', escape(supplier?.companyName || '—')]])}
          ${ctaButton(link, 'View the live listing')}
        `,
      });
      const text = `${exp.name} from ${supplier?.companyName || 'your supplier'} is now live. Have a look: ${link}`;
      await mail({ to: kam.email, subject: `Live: "${exp.name}" from ${supplier?.companyName || 'your supplier'}`, html, text });
    }
    reviewNotify.notify({
      recipientType: 'team', recipientId: kam.id, experienceId: exp.id, kind: 'live',
      title: `Supplier listing live: "${exp.name}"`,
      message: `One more experience from ${supplier?.companyName || 'your supplier'} is now live.`,
    }).catch(() => {});
  }

  // 3. BD — only when a BD onboarded this listing.
  if (exp.createdByTeamMemberId) {
    const bd = await TeamMember.findByPk(exp.createdByTeamMemberId, { attributes: ['id', 'name', 'email', 'roleType'] });
    if (bd?.roleType === 'bd') {
      if (bd.email) {
        const html = emailShell({
          preheader: `${exp.name} you onboarded is now live`,
          eyebrow: 'Your listing is live 🎉',
          heading: escape(exp.name || 'Experience'),
          bodyHtml: `
            <p style="color:#374151;line-height:1.6;margin:0 0 16px;">
              Hi ${escape(bd.name || 'there')}, the experience you onboarded${supplier?.companyName ? ` for <strong>${escape(supplier.companyName)}</strong>` : ''}
              is now live on the website and app.
            </p>
            ${detailRows(exp, supplier?.companyName ? [['Supplier', escape(supplier.companyName)]] : [])}
            ${ctaButton(link, 'View the live listing')}
          `,
        });
        const text = `The experience you onboarded, ${exp.name}, is now live: ${link}`;
        await mail({ to: bd.email, subject: `Live: "${exp.name}" is now on the website`, html, text });
      }
      reviewNotify.notify({
        recipientType: 'team', recipientId: bd.id, experienceId: exp.id, kind: 'live',
        title: `Your listing is live: "${exp.name}"`,
        message: `The experience you onboarded${supplier?.companyName ? ` for ${supplier.companyName}` : ''} is now live.`,
      }).catch(() => {});
    }
  }

  // 4. Center Ops — all active.
  const copsTeam = await TeamMember.findAll({ where: { roleType: 'cops', isActive: true }, attributes: ['id', 'name', 'email'] });
  await Promise.all(copsTeam.map(async (c) => {
    if (c.email) {
      const html = emailShell({
        preheader: `${exp.name} is now live`,
        eyebrow: 'Now live 🎉',
        heading: escape(exp.name || 'Experience'),
        bodyHtml: `
          <p style="color:#374151;line-height:1.6;margin:0 0 16px;">A listing has completed the full onboarding flow and is now live on the website and app.</p>
          ${detailRows(exp, supplier?.companyName ? [['Supplier', escape(supplier.companyName)]] : [])}
          ${ctaButton(link, 'View the live listing')}
        `,
      });
      await mail({ to: c.email, subject: `Now live: "${exp.name}"`, html, text: `${exp.name} is now live: ${link}` });
    }
    reviewNotify.notify({
      recipientType: 'team', recipientId: c.id, experienceId: exp.id, kind: 'live',
      title: `Now live: "${exp.name}"`, message: 'A listing completed onboarding and is live.',
    }).catch(() => {});
  }));

  // 5. QCOPS who checked it.
  if (exp.qcopsTeamMemberId) {
    const q = await TeamMember.findByPk(exp.qcopsTeamMemberId, { attributes: ['id', 'name', 'email'] });
    if (q?.email) {
      const html = emailShell({
        preheader: `${exp.name} you checked is now live`,
        eyebrow: 'Now live 🎉',
        heading: escape(exp.name || 'Experience'),
        bodyHtml: `
          <p style="color:#374151;line-height:1.6;margin:0 0 16px;">
            Hi ${escape(q.name || 'there')}, a listing you checked on-site has passed and is now live.
          </p>
          ${detailRows(exp)}
          ${ctaButton(link, 'View the live listing')}
        `,
      });
      await mail({ to: q.email, subject: `Now live: "${exp.name}"`, html, text: `A listing you checked is now live: ${exp.name} — ${link}` });
    }
    // In-app to QCOPS is emitted by publishLive already.
  }
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
  notifyWentLive,
  notifyCopsQcSchedule,
  notifySupplierChangeDeadline,
  notifySubmitterDecision,
  notifySupplierQcVisit,
  notifyQcopsAssignment,
  notifyQcFeedback,
  TEAM_PORTAL_URL,
  SUPPLIER_PORTAL_URL,
};
