const { Op } = require('sequelize');
const { Experience } = require('../models');
const reviewNotify = require('./reviewNotify.service');

/*
  Once a day-of, remind the assigned QCOPS that today is their on-site visit
  (and nudge the assigning COPS). Idempotent per visit via qcReview.remindedAt.
  Called from the server's periodic sweep.
*/
const todayStr = () => new Date().toISOString().slice(0, 10);

const sweepQcVisitReminders = async () => {
  const today = todayStr();
  const rows = await Experience.findAll({
    where: { reviewStage: { [Op.in]: ['qc_assigned', 'qc_acknowledged'] }, qcopsTeamMemberId: { [Op.ne]: null } },
    attributes: ['id', 'name', 'qcopsTeamMemberId', 'qcReview'],
  });
  let sent = 0;
  for (const exp of rows) {
    const qc = exp.qcReview || {};
    if (qc.visitDate !== today || qc.remindedAt) continue;

    // eslint-disable-next-line no-await-in-loop
    await reviewNotify.notify({
      recipientType: 'team', recipientId: exp.qcopsTeamMemberId, experienceId: exp.id,
      kind: 'qc_reminder',
      title: `Today is your visit day: "${exp.name}"`,
      message: `Visit at ${qc.visitTime || ''}. Confirm you’re on-site, then submit your feedback.`,
      meta: { visitDate: qc.visitDate, visitTime: qc.visitTime },
    }).catch(() => {});
    if (qc.assignedByCopsId) {
      // eslint-disable-next-line no-await-in-loop
      await reviewNotify.notify({
        recipientType: 'team', recipientId: qc.assignedByCopsId, experienceId: exp.id,
        kind: 'qc_reminder',
        title: `QCOPS visits "${exp.name}" today`,
        message: `Scheduled for ${qc.visitTime || ''}.`,
      }).catch(() => {});
    }

    exp.qcReview = { ...qc, remindedAt: new Date().toISOString() };
    // eslint-disable-next-line no-await-in-loop
    await exp.save();
    sent += 1;
  }
  return { sent };
};

module.exports = { sweepQcVisitReminders };
