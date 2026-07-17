const { sequelize } = require('../config/database');

/*
  Creates the review_notifications table if it isn't there yet. In dev the
  boot-time sync({alter:true}) would create it anyway, but production runs
  sync({}) which never creates tables — so we do it explicitly here.
  Idempotent (CREATE TABLE IF NOT EXISTS).
*/
const migrate = async () => {
  const changes = [];
  const [existing] = await sequelize.query("SHOW TABLES LIKE 'review_notifications'");
  if (existing.length > 0) return { changes };
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS \`review_notifications\` (
      \`id\` INT NOT NULL AUTO_INCREMENT,
      \`recipientType\` ENUM('team','user','supplier') NOT NULL,
      \`recipientId\` INT NOT NULL,
      \`experienceId\` INT NULL,
      \`kind\` VARCHAR(24) NOT NULL,
      \`title\` VARCHAR(200) NOT NULL,
      \`message\` TEXT NULL,
      \`meta\` JSON NULL,
      \`readAt\` DATETIME NULL,
      \`createdAt\` DATETIME NOT NULL,
      \`updatedAt\` DATETIME NOT NULL,
      PRIMARY KEY (\`id\`),
      KEY \`rn_recipient_idx\` (\`recipientType\`, \`recipientId\`, \`readAt\`),
      KEY \`rn_experience_idx\` (\`experienceId\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  changes.push('review_notifications table created');
  return { changes };
};

module.exports = { migrate };
