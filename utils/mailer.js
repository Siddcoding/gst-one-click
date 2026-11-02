const nodemailer = require('nodemailer');

const SMTP_CONFIGURED = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

let transporter = null;
if (SMTP_CONFIGURED) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

const FROM = process.env.SMTP_FROM || '"GST OneClick" <no-reply@example.com>';

/**
 * Sends an email if SMTP is configured. If not, logs the content to the
 * console instead — so signup/reset flows still work end-to-end during
 * local development, and you can see exactly what the email would say.
 */
async function sendMail({ to, subject, html, text }) {
  if (!SMTP_CONFIGURED) {
    console.log('\n──────────────────────────────────────────────');
    console.log('  SMTP NOT CONFIGURED — email logged instead of sent');
    console.log(`  To:      ${to}`);
    console.log(`  Subject: ${subject}`);
    console.log(`  Content:\n${text || html}`);
    console.log('──────────────────────────────────────────────\n');
    return { logged: true };
  }

  try {
    await transporter.sendMail({ from: FROM, to, subject, html, text });
    return { sent: true };
  } catch (err) {
    console.error('Failed to send email:', err.message);
    // Still log the content so the flow isn't a dead end if SMTP creds are wrong
    console.log(`Email content (send failed) — To: ${to} | ${text || html}`);
    throw new Error('Could not send email right now. Please try again shortly.');
  }
}

module.exports = { sendMail, SMTP_CONFIGURED };
