# Mailery self_hosted service — ARM64 / Bun.
#
# Runs mailery-serve in cloud mode (PURE REMOTE, Amendment A1): the
# API-key-authenticated /v1 surface + /health,/ready,/version probes, reading
# and writing the shared cloud Postgres. The same image runs the one-shot
# migration task via `mailery db migrate`.
FROM --platform=linux/arm64 oven/bun:1.3 AS base
WORKDIR /app

# RDS TLS: bake the Amazon RDS global CA bundle so verify-full DSNs
# (pg-connection-string treats sslmode=require as verify-full) validate the
# shared RDS cert chain. NODE_EXTRA_CA_CERTS adds it to Node's trust store.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
      -o /etc/ssl/certs/rds-global-bundle.pem \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem

# Install dependencies first for layer caching. bun.lock is not tracked in this
# repo, so resolve from package.json (production deps only).
COPY package.json ./
RUN bun install --production

# Application source (run directly with Bun — no build step needed).
COPY tsconfig.json ./
COPY src ./src

# Console wrappers so `mailery` / `mailery-serve` resolve on PATH exactly as the
# published bins do (the deploy migration task runs `mailery db migrate`).
RUN printf '#!/bin/sh\nexec bun /app/src/cli/index.tsx "$@"\n' > /usr/local/bin/mailery \
 && printf '#!/bin/sh\nexec bun /app/src/server/index.ts "$@"\n' > /usr/local/bin/mailery-serve \
 && chmod +x /usr/local/bin/mailery /usr/local/bin/mailery-serve

ENV PORT=8080 \
    HOST=0.0.0.0 \
    HASNA_MAILERY_STORAGE_MODE=cloud \
    NODE_ENV=production

EXPOSE 8080

# Default: run the HTTP service. The migration task overrides the command with
# ["mailery","db","migrate"].
CMD ["mailery-serve"]
