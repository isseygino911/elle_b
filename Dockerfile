# =============================================================================
# Student CRM — API Dockerfile (production)
# =============================================================================
# Builds the Express API only. The React client is NOT built here — it's
# compiled to static files on the host (`npm --prefix client run build`) and
# served directly by Caddy from client/dist, per DEPLOY.md.
#
# Secrets are never baked into the image:
#   - server/.env is injected at runtime via docker-compose's `env_file`.
#   - server/keys/ (JWT RS256 keypair) is mounted read-only at runtime, not
#     copied into the build context (see .dockerignore).
# =============================================================================

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .

USER node
EXPOSE 4000
CMD ["node", "src/index.js"]
