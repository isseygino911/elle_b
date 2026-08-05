// Single source of truth for process.env. No other file should read
// process.env directly — import the values you need from here instead.

const REQUIRED_VARS = [
  'PORT',
  'CORS_ORIGIN',
  'DB_HOST',
  'DB_PORT',
  'DB_NAME',
  'DB_USER',
  'JWT_PRIVATE_KEY_PATH',
  'JWT_PUBLIC_KEY_PATH',
  'JWT_ACCESS_TOKEN_TTL',
  'JWT_REFRESH_TOKEN_TTL',
  'AWS_REGION',
  'AWS_S3_BUCKET'
];

const missing = REQUIRED_VARS.filter((name) => {
  const value = process.env[name];
  return value === undefined || value === '';
});

if (missing.length > 0) {
  throw new Error(
    `Missing required environment variable(s): ${missing.join(', ')}`
  );
}

module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT),
  corsOrigin: process.env.CORS_ORIGIN,
  db: {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    name: process.env.DB_NAME,
    user: process.env.DB_USER,
    // DB_PASSWORD may legitimately be blank in local dev (e.g. root user
    // with no password set), so it is not part of REQUIRED_VARS.
    password: process.env.DB_PASSWORD || ''
  },
  jwt: {
    privateKeyPath: process.env.JWT_PRIVATE_KEY_PATH,
    publicKeyPath: process.env.JWT_PUBLIC_KEY_PATH,
    accessTokenTtl: process.env.JWT_ACCESS_TOKEN_TTL,
    refreshTokenTtl: process.env.JWT_REFRESH_TOKEN_TTL
  },
  aws: {
    region: process.env.AWS_REGION,
    bucket: process.env.AWS_S3_BUCKET
  },
  // Outbound mail (password reset links). Deliberately NOT in REQUIRED_VARS:
  // the app has to boot without mail credentials, both because they don't
  // exist yet and because a mail misconfiguration should degrade sending, not
  // take the whole API down. src/utils/mailer.js treats "no user/password" as
  // "no transport configured" and says so explicitly at startup.
  smtp: {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER || '',
    // For Gmail this is a 16-character App Password, never the account
    // password — see .env.example.
    password: process.env.SMTP_PASSWORD || '',
    // What recipients see in the From: header. Falls back to the auth user,
    // since Gmail rejects a From that isn't the authenticated account (or one
    // of its verified aliases) anyway.
    from: process.env.MAIL_FROM || process.env.SMTP_USER || ''
  }
};
