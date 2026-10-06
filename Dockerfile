# syntax=docker/dockerfile:1

# ---- deps: install production dependencies only ----
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---- test: run unit tests against the exact sources being shipped ----
FROM deps AS test
COPY server ./server
COPY public ./public
RUN node --disable-warning=ExperimentalWarning --test

# ---- runtime: one small image serving API + static app ----
FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
WORKDIR /app
RUN apk add --no-cache tini su-exec && mkdir -p /data/uploads && chown -R node:node /data
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --from=test --chown=node:node /app/server ./server
COPY --chown=node:node public ./public
COPY docker-entrypoint.sh /usr/local/bin/
RUN rm -f server/*.test.js
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1:${PORT}/api/auth/me >/dev/null || exit 1
# Starts as root only to fix /data ownership, then runs as the unprivileged `node` user.
ENTRYPOINT ["/sbin/tini", "--", "docker-entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
