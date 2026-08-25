const path = require('path');

// Defaults to .env -- which points at production, so `npm run dev` and
// `npm start` keep the behaviour they have always had. ENV_FILE opts a single
// process into a different one: `npm run local` pins it at .env.dev, the local
// Docker container on 3307. Same reasoning as seed-dev.js's DEV_ENV_FILE, which
// refuses to fall back to .env for exactly this reason.
require('dotenv').config({ path: path.join(__dirname, '..', process.env.ENV_FILE || '.env') });

const app = require('./app');
const config = require('./config/env');
const { isConfigured } = require('./utils/mailer');

const server = app.listen(config.port, () => {
  console.log(`Server listening on port ${config.port}`);

  // Password reset cannot report its own delivery failures — the endpoint
  // answers identically whether or not the address exists, so a missing
  // transport is invisible at request time. Saying so once at startup is the
  // only place it can be noticed before a user fails to receive a link.
  if (!isConfigured()) {
    console.log(
      'Mail: no SMTP credentials — password reset links will be ' +
        (config.nodeEnv === 'production'
          ? 'SKIPPED (production). Set SMTP_USER/SMTP_PASSWORD to enable email.'
          : 'logged to this console. See .env.example.')
    );
  } else {
    console.log(`Mail: SMTP configured (${config.smtp.host} as ${config.smtp.user}).`);
  }
});

// `npm run dev` and `npm run local` both free the port before starting (see the
// port:free script), so this is the bypass path: `node src/index.js` run
// directly while another server still holds the port. Without a handler the
// bind failure is an unhandled error -- the node process dies but its parent
// nodemon survives, which is how orphaned nodemons accumulate and every later
// start loses the race for the port.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `Port ${config.port} is already in use — another server is still running.\n` +
        '  Free it with:  npm run port:free'
    );
    process.exit(1);
  }

  throw err;
});
