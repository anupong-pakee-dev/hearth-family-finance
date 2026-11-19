# syntax=docker/dockerfile:1.7
# Hearth Family Finance — single minimal image (NFR-SEC-30)
#  - build stage installs only production dependencies from the lockfile
#  - runtime is distroless (no shell, no package manager), runs as non-root
# Pin both base images by digest in release builds (Dependabot / Renovate keeps them fresh).

FROM node:26-trixie-slim AS deps
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM gcr.io/distroless/nodejs24-debian13:nonroot
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    HEARTH_DATA_DIR=/tmp/hearth \
    LOG_LEVEL=info
COPY --from=deps --chown=nonroot:nonroot /app/node_modules ./node_modules
COPY --chown=nonroot:nonroot package.json ./
COPY --chown=nonroot:nonroot packages/engine ./packages/engine
COPY --chown=nonroot:nonroot apps/web/package.json ./apps/web/package.json
COPY --chown=nonroot:nonroot apps/web/src ./apps/web/src
COPY --chown=nonroot:nonroot apps/web/public ./apps/web/public
COPY --chown=nonroot:nonroot apps/web/scripts ./apps/web/scripts
COPY --chown=nonroot:nonroot plugins ./plugins
USER nonroot
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["apps/web/src/server.ts"]
