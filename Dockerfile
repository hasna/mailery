# syntax=docker/dockerfile:1.7

# Reproducible Emails self-hosted runtime. No deployment or account defaults are
# embedded in the image; the operator supplies Postgres, auth, and provider config.
ARG BUN_IMAGE=oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0

FROM ${BUN_IMAGE} AS base

FROM base AS dependencies
WORKDIR /app

COPY package.json bun.lock ./
COPY scripts/ensure-private-data-dir.mjs ./scripts/ensure-private-data-dir.mjs
RUN bun install --production --frozen-lockfile

FROM base AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    EMAILS_MODE=self_hosted \
    EMAILS_DATABASE_CA_FILE=/opt/emails/certs/aws-rds-global-bundle.pem \
    NODE_EXTRA_CA_CERTS=/opt/emails/certs/aws-rds-global-bundle.pem \
    HOST=0.0.0.0 \
    PORT=8080

RUN mkdir -p /opt/emails/certs \
    && chown root:root /opt /opt/emails /opt/emails/certs \
    && chmod 0755 /opt /opt/emails /opt/emails/certs

# Official Amazon RDS global trust bundle, content-pinned for reproducible and
# fail-closed image builds. To rotate it, review the new AWS bundle and update
# this checksum together with the TLS/container contract tests.
ADD --checksum=sha256:e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3 \
    --chown=root:root --chmod=0444 \
    https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    /opt/emails/certs/aws-rds-global-bundle.pem

COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json tsconfig.json ./
COPY --chown=bun:bun src ./src

USER bun
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "const r=await fetch('http://127.0.0.1:8080/ready');process.exit(r.ok?0:1)"]

CMD ["bun", "src/server/index.ts"]
