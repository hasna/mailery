# syntax=docker/dockerfile:1.7

# Reproducible Emails self-hosted runtime. No deployment or account defaults are
# embedded in the image; the operator supplies Postgres, auth, and provider config.
ARG BUN_IMAGE=oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0

FROM ${BUN_IMAGE} AS base
RUN apk add --no-cache --upgrade \
      'libcrypto3=3.5.7-r0' \
      'libssl3=3.5.7-r0' \
    && apk info --installed 'libcrypto3=3.5.7-r0' \
    && apk info --installed 'libssl3=3.5.7-r0'

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
RUN mkdir -p /runtime/usr/local/bin /runtime/lib /runtime/lib/apk/db /runtime/usr/lib \
    /runtime/opt/emails/certs /runtime/tmp /runtime/home/bun/.hasna/emails /runtime/etc \
    /runtime/app /runtime/app/data /runtime/home/bun \
    && cp -a /usr/local/bin/bun /runtime/usr/local/bin/bun \
    && cp -a /etc/alpine-release /runtime/etc/alpine-release \
    && awk 'BEGIN { RS = ""; order[1] = "libgcc"; order[2] = "libstdc++"; order[3] = "musl"; expected["libgcc"] = 1; expected["libstdc++"] = 1; expected["musl"] = 1 } { name = ""; line_count = split($0, lines, "\n"); for (line = 1; line <= line_count; line++) { if (substr(lines[line], 1, 2) == "P:") { name = substr(lines[line], 3); break } } if (name in expected) { if (name in records) { print "duplicate apk package record: " name > "/dev/stderr"; failed = 1 } records[name] = $0 } } END { for (position = 1; position <= 3; position++) { name = order[position]; if (!(name in records)) { print "missing apk package record: " name > "/dev/stderr"; failed = 1 } } if (failed) exit 1; for (position = 1; position <= 3; position++) { name = order[position]; printf "%s\n\n", records[name] } }' /lib/apk/db/installed > /runtime/lib/apk/db/installed \
    && ln -sf bun /runtime/usr/local/bin/bunx \
    && ln -sf bun /runtime/usr/local/bin/node \
    && cp -a /lib/ld-musl-*.so.1 /runtime/lib/ \
    && cp -a /lib/libc.musl-*.so.1 /runtime/lib/ \
    && cp -a /usr/lib/libgcc_s.so.1 /runtime/usr/lib/libgcc_s.so.1 \
    && cp -a /usr/lib/libstdc++.so.6* /runtime/usr/lib/ \
    && printf '%s\n' 'bun:x:1000:1000:Bun:/home/bun:/sbin/nologin' > /runtime/etc/passwd \
    && printf '%s\n' 'bun:x:1000:' > /runtime/etc/group \
    && chmod 0644 /runtime/etc/passwd /runtime/etc/group \
    && chmod 1777 /runtime/tmp \
    && chmod 0700 /runtime/home/bun/.hasna/emails \
    && chown -R 1000:1000 /runtime/home/bun /runtime/home/bun/.hasna/emails /runtime/app /runtime/app/data

ADD --checksum=sha256:e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3 \
    --chown=root:root --chmod=0444 \
    https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    /runtime/opt/emails/certs/aws-rds-global-bundle.pem

FROM scratch

ARG VERSION=dev
ARG REVISION=unknown

LABEL org.opencontainers.image.source="https://github.com/hasna/emails" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$REVISION"

ENV HOME=/home/bun \
    PATH=/usr/local/bin \
    EMAILS_MODE=self_hosted \
    EMAILS_DATABASE_CA_FILE=/opt/emails/certs/aws-rds-global-bundle.pem \
    NODE_EXTRA_CA_CERTS=/opt/emails/certs/aws-rds-global-bundle.pem \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080

COPY --from=runtime-files /runtime/ /
COPY --chown=1000:1000 --from=build /app/node_modules /app/node_modules
COPY --chown=1000:1000 --from=build /app/package.json /app/package.json
COPY --chown=1000:1000 --from=build /app/src /app/src

WORKDIR /app
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/usr/local/bin/bun", "-e", "const port = Number(process.env.PORT || 8080); const mode = process.env.EMAILS_MODE?.trim().toLowerCase(); const path = mode === 'local' ? '/api/providers?limit=1' : '/ready'; const r=await fetch(`http://127.0.0.1:${port}${path}`);process.exit(r.ok?0:1)"]

VOLUME ["/tmp"]
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/bun"]
CMD ["src/server/index.ts"]
