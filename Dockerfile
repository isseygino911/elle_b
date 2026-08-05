# =============================================================================
# Student CRM — API Dockerfile (production)
# =============================================================================
# Builds the Express API only. The React client is NOT built here — it lives
# in a separate repo (elle_f), is compiled to static files, and is served
# directly by Caddy from its dist/, per DEPLOY.md.
#
# Secrets are never baked into the image:
#   - .env is injected at runtime via docker-compose's `env_file`.
#   - keys/ (JWT RS256 keypair) is mounted read-only at runtime, not copied
#     into the build context (see .dockerignore).
#
# Node 22 LTS: the AWS SDK v3 (@aws-sdk/client-s3 et al) emits a
# NodeVersionSupportWarning on Node 20 and drops support for it entirely for
# releases published after the first week of January 2027. argon2 ships a
# musl prebuild, so alpine needs no build toolchain for it.
# =============================================================================

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules

# Copy only what the API needs at runtime. An unqualified `COPY . .` also
# baked in host-level deploy config (Caddyfile, ecosystem.config.js, the
# compose files, infra/, DEPLOY.md, .claude/) — none of which the container
# ever reads, and all of which invalidate the image layer on every edit.
# migrations/ is included so `npm run migrate` can be run via `docker compose
# exec` against the same image that runs the API.
COPY package.json package-lock.json ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts

USER node
EXPOSE 4000

# Lets Docker/compose surface a genuinely unhealthy API (e.g. the DB went
# away) rather than reporting the container up merely because node is alive.
# Mirrors the /api/health route, which pings the DB with SELECT 1.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/index.js"]
