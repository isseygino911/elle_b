// Outbound mail — password reset links.
//
// Delivery is isolated here so nothing upstream knows how a message travels.
// Two modes, chosen by whether SMTP credentials are configured:
//
//   configured   -> sent over SMTP (Gmail by default)
//   unconfigured -> logged to the server console outside production, and
//                   silently skipped in production
//
// The unconfigured path is not a placeholder to rip out later: it is what
// keeps the app runnable on a machine with no mail credentials, which is
// every developer's machine and CI.
//
// GMAIL SETUP (see .env.example for the variable names):
//   Gmail rejects plain account passwords over SMTP. You need an App
//   Password, which requires 2-Step Verification on the account:
//     1. Enable 2-Step Verification: https://myaccount.google.com/security
//     2. Create an App Password:     https://myaccount.google.com/apppasswords
//     3. Put the 16-character value in SMTP_PASSWORD (spaces are fine — they
//        are stripped below), and the Gmail address in SMTP_USER.
//   Google's free tier allows roughly 500 recipients/day, which is ample for
//   password resets but is a real ceiling worth knowing about.

const nodemailer = require('nodemailer');
const config = require('../config/env');

// Built once and reused: each nodemailer transport keeps its own connection
// pool, so constructing one per email would open a new TLS handshake to Gmail
// every time.
let cachedTransport;

function isConfigured() {
  return Boolean(config.smtp.user && config.smtp.password);
}

function getTransport() {
  if (!cachedTransport) {
    cachedTransport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      // Port 465 is implicit TLS; 587 starts plaintext and upgrades via
      // STARTTLS. Deriving this from the port rather than adding another env
      // var keeps the two from contradicting each other.
      secure: config.smtp.port === 465,
      auth: {
        user: config.smtp.user,
        // Google displays App Passwords in groups of four ("abcd efgh ijkl
        // mnop") and people paste them that way. The spaces are presentation
        // only and authentication fails if they are sent.
        pass: config.smtp.password.replace(/\s+/g, '')
      }
    });
  }
  return cachedTransport;
}

// The link the recipient clicks. Built from CORS_ORIGIN because that is
// already the configured address of the frontend — a second "where does the
// app live" variable would only invite the two drifting apart.
function buildResetLink(token) {
  const base = config.appOrigin;
  return `${base}/reset-password?token=${encodeURIComponent(token)}`;
}

function resetEmailContent({ name, link }) {
  const greeting = name ? `Hi ${name},` : 'Hi,';

  const text = [
    greeting,
    '',
    'We received a request to reset your Elle password.',
    'Open the link below to choose a new one. It expires in one hour and can only be used once.',
    '',
    link,
    '',
    "If you didn't ask for this, you can ignore this email — your password will stay as it is.",
    '',
    '— Elle'
  ].join('\n');

  // Kept to plain tags and inline styles on purpose: mail clients strip
  // <style> blocks and support no modern CSS worth relying on. The link is
  // also shown as text because some clients refuse to render anchors.
  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; font-size: 15px; line-height: 1.6; color: #1a1a1a;">
      <p>${escapeHtml(greeting)}</p>
      <p>We received a request to reset your Elle password.</p>
      <p>
        <a href="${escapeHtml(link)}" style="display: inline-block; padding: 10px 18px; background: #1a1a1a; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600;">
          Choose a new password
        </a>
      </p>
      <p style="color: #666666; font-size: 13px;">
        This link expires in one hour and can only be used once. If the button doesn't work,
        copy this address into your browser:<br />
        <span style="word-break: break-all;">${escapeHtml(link)}</span>
      </p>
      <p style="color: #666666; font-size: 13px;">
        If you didn't ask for this, you can ignore this email — your password will stay as it is.
      </p>
      <p style="color: #666666; font-size: 13px;">— Elle</p>
    </div>
  `;

  return { text, html };
}

// The name is user-controlled and lands inside an HTML document, so it is
// escaped rather than interpolated raw. The link is escaped too: it carries a
// token that is hex-only today, but the escaping should not depend on that
// staying true.
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Deliver a password reset link.
//
// NEVER throws. A mail outage must not turn "if that email is registered,
// we've sent a link" into a 500 — that response is identical for known and
// unknown addresses precisely so it cannot be used to test whether an account
// exists, and an error leaking out here would undo that.
//
// Returns { delivered, reason } for logging and tests. The route deliberately
// does not vary its response on this value.
async function sendPasswordResetEmail({ to, name, token }) {
  const link = buildResetLink(token);

  if (!isConfigured()) {
    if (config.nodeEnv === 'production') {
      // Intentionally silent: writing a live reset link into production logs
      // would put a working credential everywhere logs are shipped.
      return { delivered: false, reason: 'no-transport-configured' };
    }

    // eslint-disable-next-line no-console
    console.log(
      `\n[password-reset] No SMTP credentials configured — link for ${name || to} <${to}>:\n  ${link}\n`
    );
    return { delivered: false, reason: 'logged-to-console', link };
  }

  const { text, html } = resetEmailContent({ name, link });

  try {
    await getTransport().sendMail({
      from: config.smtp.from,
      to,
      subject: 'Reset your Elle password',
      text,
      html
    });
    return { delivered: true };
  } catch (err) {
    // Logged with the address but WITHOUT the link, so a failure is
    // diagnosable without writing a usable credential to the log.
    // eslint-disable-next-line no-console
    console.error(`[password-reset] Failed to send to <${to}>:`, err.message);
    return { delivered: false, reason: 'send-failed' };
  }
}

// Verify SMTP credentials without sending anything. Used by the
// `npm run check:mail` script so a misconfiguration is caught deliberately
// rather than discovered by a user who never received their reset link.
async function verifyMailTransport() {
  if (!isConfigured()) {
    return { ok: false, reason: 'no-transport-configured' };
  }
  try {
    await getTransport().verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

module.exports = {
  sendPasswordResetEmail,
  buildResetLink,
  verifyMailTransport,
  isConfigured
};
