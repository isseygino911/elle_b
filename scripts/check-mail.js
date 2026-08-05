// Verifies SMTP credentials without sending anything to a real person.
//
// Password reset fails silently by design — if Gmail rejects the credentials,
// the API still answers "if that email is registered, a link has been sent",
// because varying that response would reveal which addresses have accounts.
// That is the right behaviour for the endpoint and a terrible way to find out
// your credentials are wrong, so this script is the deliberate check.
//
// Usage (from elle_b/):
//   npm run check:mail                  -- verify the connection only
//   npm run check:mail -- you@gmail.com -- verify, then send a real test email
//
// Exits non-zero on failure so CI or a deploy step can gate on it.

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const config = require('../src/config/env');
const { verifyMailTransport, sendPasswordResetEmail, isConfigured } = require('../src/utils/mailer');

async function main() {
  const recipient = process.argv[2];

  if (!isConfigured()) {
    console.log('SMTP is not configured.');
    console.log('  SMTP_USER and SMTP_PASSWORD are both required to send mail.');
    console.log('  See .env.example for how to create a Gmail App Password.');
    console.log('');
    console.log('  Password reset still works without them: the link is logged to');
    console.log('  this console in development, and skipped in production.');
    process.exit(1);
  }

  console.log(`Checking ${config.smtp.host}:${config.smtp.port} as ${config.smtp.user}...`);

  const result = await verifyMailTransport();

  if (!result.ok) {
    console.error('FAILED:', result.reason);
    console.error('');
    console.error('Common causes with Gmail:');
    console.error('  - Using the account password instead of a 16-character App Password');
    console.error('  - 2-Step Verification not enabled (App Passwords require it)');
    console.error('  - SMTP_PORT set to 465 while expecting STARTTLS, or vice versa');
    process.exit(1);
  }

  console.log('OK: SMTP credentials accepted.');

  if (!recipient) {
    console.log('');
    console.log('To send a real test email:  npm run check:mail -- you@example.com');
    return;
  }

  // A genuine reset-shaped email, but with an obviously fake token: this
  // proves rendering and delivery without minting a working credential.
  console.log(`Sending a test email to ${recipient}...`);
  const sent = await sendPasswordResetEmail({
    to: recipient,
    name: 'Test Recipient',
    token: 'test-token-not-valid-for-any-account'
  });

  if (sent.delivered) {
    console.log('OK: test email accepted by the server. Check the inbox (and spam).');
    console.log('Note: its reset link is deliberately non-functional.');
  } else {
    console.error('FAILED to send:', sent.reason);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Unexpected error:', err.message);
    process.exit(1);
  });
