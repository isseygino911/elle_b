// =============================================================================
// Student CRM — PM2 Ecosystem Config (Production)
// =============================================================================
// Manages exactly one process: the Express API server. The React client
// lives in a separate repo, built to static assets and served by Caddy —
// it is not a PM2-managed process. Non-Docker fallback; docker-compose.prod.yml
// is the primary deploy path (see DEPLOY.md).
//
// Usage on the VPS (whoever has SSH/PM2 access), from this repo's root:
//   pm2 start ecosystem.config.js
//   pm2 save
// =============================================================================

module.exports = {
  apps: [
    {
      name: 'student-crm-api',
      script: 'src/index.js',
      cwd: '.',
      env: {
        NODE_ENV: 'production',
      },
      watch: false,
      out_file: './logs/student-crm-api.out.log',
      error_file: './logs/student-crm-api.error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
