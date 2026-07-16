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

FROM base AS build
WORKDIR /app

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY --chown=bun:bun src ./src

FROM base AS runtime-files
RUN mkdir -p /runtime/usr/local/bin /runtime/lib /runtime/usr/lib \
    /runtime/opt/emails/certs /runtime/tmp /runtime/home/bun/.hasna/emails \
    /runtime/app /runtime/app/data /runtime/home/bun \
    && cp -a /usr/local/bin/bun /runtime/usr/local/bin/bun \
    && ln -sf bun /runtime/usr/local/bin/bunx \
    && ln -sf bun /runtime/usr/local/bin/node \
    && cp -a /lib/ld-musl-*.so.1 /runtime/lib/ \
    && cp -a /lib/libc.musl-*.so.1 /runtime/lib/ \
    && cp -a /usr/lib/libgcc_s.so.1 /runtime/usr/lib/libgcc_s.so.1 \
    && cp -a /usr/lib/libstdc++.so.6* /runtime/usr/lib/ \
    && chmod 1777 /runtime/tmp \
    && chmod 0700 /runtime/home/bun/.hasna/emails \
    && chown -R 1000:1000 /runtime/home/bun /runtime/home/bun/.hasna/emails /runtime/app /runtime/app/data

ADD --checksum=sha256:e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3 \
    --chown=root:root --chmod=0444 \
    https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    /runtime/opt/emails/certs/aws-rds-global-bundle.pem

FROM scratch

ENV HOME=/home/bun \
    PATH=/usr/local/bin \
    EMAILS_MODE=self_hosted \
    EMAILS_DATABASE_CA_FILE=/opt/emails/certs/aws-rds-global-bundle.pem \
    NODE_EXTRA_CA_CERTS=/opt/emails/certs/aws-rds-global-bundle.pem \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080

COPY --from=runtime-files /runtime/usr/local/bin/bun /usr/local/bin/bun
COPY --from=runtime-files /runtime/usr/local/bin/bunx /usr/local/bin/bunx
COPY --from=runtime-files /runtime/usr/local/bin/node /usr/local/bin/node
COPY --from=runtime-files /runtime/lib/ld-musl-*.so.1 /lib/
COPY --from=runtime-files /runtime/lib/libc.musl-*.so.1 /lib/
COPY --from=runtime-files /runtime/usr/lib/libgcc_s.so.1 /usr/lib/libgcc_s.so.1
COPY --from=runtime-files /runtime/usr/lib/libstdc++.so.6* /usr/lib/
COPY --from=runtime-files /runtime/opt/emails/certs/aws-rds-global-bundle.pem /opt/emails/certs/aws-rds-global-bundle.pem
COPY --from=runtime-files /runtime/tmp /tmp
COPY --from=runtime-files /runtime/home/bun/.hasna/emails /home/bun/.hasna/emails
COPY --from=runtime-files /runtime/app/data /app/data
COPY --chown=1000:1000 --from=build /app/node_modules ./node_modules
COPY --chown=1000:1000 --from=build /app/package.json /app/package.json
COPY --chown=1000:1000 --from=build /app/bun.lock /app/bun.lock
COPY --chown=1000:1000 --from=build /app/tsconfig.json /app/tsconfig.json
COPY --chown=1000:1000 --from=build /app/src ./src

WORKDIR /app
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/usr/local/bin/bun", "-e", "const port = Number(process.env.PORT || 8080); const r=await fetch(`http://127.0.0.1:${port}/ready`);process.exit(r.ok?0:1)"]

USER 1000:1000
ENTRYPOINT ["/usr/local/bin/bun"]
CMD ["src/server/index.ts"]
