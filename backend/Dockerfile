# Pulse ERP — backend
#
# Multi-stage so the runtime image carries production dependencies only.
#
# postgresql-client is installed deliberately: scripts/db-backup.js shells out to
# pg_dump/psql, and the backup cron runs inside this container. Without the client
# tools the nightly backup fails silently at 02:00 IST and you find out when you
# need to restore.

# ── deps ──────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

# pg_dump/psql for backups; tini for correct signal handling so SIGTERM reaches
# node and in-flight requests drain instead of being killed.
RUN apk add --no-cache postgresql16-client tini

ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Writable by the app user for uploads, backups and logs. Mount volumes over
# these in compose — a container filesystem does not survive a restart, and
# /app/backups holding the only copy of a backup is not a backup.
RUN mkdir -p uploads backups logs && chown -R node:node uploads backups logs
USER node

EXPOSE 5000

# Uses the same endpoint the platform health checks hit (render.yaml,
# railway.toml). Start period is generous because migrations run on boot.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
