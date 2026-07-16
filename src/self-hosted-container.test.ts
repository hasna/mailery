import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const dockerfile = readFileSync(resolve(import.meta.dir, "../Dockerfile"), "utf8");
const packageJson = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../package.json"), "utf8"),
);
const bundlePath = "/opt/emails/certs/aws-rds-global-bundle.pem";
const bundleSha256 = "e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3";

describe("self-hosted container TLS contract", () => {
  test("pins a pinned Bun base with minimal Alpine stages", () => {
    expect(dockerfile).toContain(
      "ARG BUN_IMAGE=oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0",
    );
    expect(dockerfile).not.toContain("ARG OPENSSL_VERSION=");
    expect(dockerfile).toContain("FROM ${BUN_IMAGE} AS base");
    expect(dockerfile).not.toMatch(/^FROM\s+--platform=/m);
    expect(dockerfile).toContain("FROM base AS dependencies");
    expect(dockerfile).toContain("FROM scratch");
    expect(dockerfile).not.toMatch(/apt-get/);
    expect(dockerfile).not.toMatch(/\bdpkg\b/);
    expect(dockerfile).not.toMatch(/glibc/);
    expect(dockerfile).not.toMatch(/\bperl\b/);
    expect(dockerfile).not.toMatch(/\bsqlite\b/);
    expect(dockerfile).not.toMatch(/"openssl=\$\{OPENSSL_VERSION\}"/);
    expect(dockerfile).not.toMatch(/"libssl3t64=\$\{OPENSSL_VERSION\}"/);
    expect(dockerfile).not.toMatch(/"openssl-provider-legacy=\$\{OPENSSL_VERSION\}"/);
    expect(dockerfile).not.toMatch(/^FROM(?:\s+--platform=\S+)?\s+oven\/bun:(?:1|latest)(?:\s|$)/m);
  });

  test("pins the official RDS trust bundle by content digest", () => {
    expect(dockerfile).toContain(
      `ADD --checksum=sha256:${bundleSha256}`,
    );
    expect(dockerfile).toContain(
      "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem",
    );
    expect(dockerfile).toContain("--chown=root:root --chmod=0444");
  });

  test("locks runtime copy semantics and ownership", () => {
    expect(dockerfile).toContain("COPY --from=runtime-files /runtime/usr/local/bin/bun /usr/local/bin/bun");
    expect(dockerfile).toContain("COPY --from=runtime-files /runtime/usr/local/bin/bunx /usr/local/bin/bunx");
    expect(dockerfile).toContain("COPY --from=runtime-files /runtime/usr/local/bin/node /usr/local/bin/node");
    expect(dockerfile).toContain("COPY --chown=1000:1000 --from=build /app/node_modules ./node_modules");
    expect(dockerfile).toContain("COPY --chown=1000:1000 --from=build /app/package.json /app/package.json");
    expect(dockerfile).toContain("COPY --chown=1000:1000 --from=build /app/bun.lock /app/bun.lock");
    expect(dockerfile).toContain("COPY --chown=1000:1000 --from=build /app/tsconfig.json /app/tsconfig.json");
    expect(dockerfile).toContain("COPY --chown=1000:1000 --from=build /app/src ./src");
    expect(dockerfile).toContain(
      "COPY --from=runtime-files /runtime/home/bun/.hasna/emails /home/bun/.hasna/emails",
    );
    expect(dockerfile).toContain("COPY --from=runtime-files /runtime/app/data /app/data");
  });

  test("enforces exact runtime permissions and runtime user", () => {
    expect(dockerfile).toContain("chmod 1777 /runtime/tmp");
    expect(dockerfile).toContain("chmod 0700 /runtime/home/bun/.hasna/emails");
    expect(dockerfile).toContain(
      "chown -R 1000:1000 /runtime/home/bun /runtime/home/bun/.hasna/emails /runtime/app /runtime/app/data",
    );
    expect(dockerfile).toContain("USER 1000:1000");
  });

  test("exports explicit PATH and bun runtime shims", () => {
    expect(dockerfile).toContain("PATH=/usr/local/bin");
    expect(dockerfile).toContain("ln -sf bun /runtime/usr/local/bin/bunx");
    expect(dockerfile).toContain("ln -sf bun /runtime/usr/local/bin/node");
  });

  test("removes permissive runtime fallback/copy behavior", () => {
    expect(dockerfile).not.toContain("locale-archive");
    expect(dockerfile).not.toContain("|| true");
  });

  test("keeps container entrypoint/cmd direct and healthcheck portable", () => {
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/bun"]');
    expect(dockerfile).toContain("CMD [\"src/server/index.ts\"]");
    expect(dockerfile).toContain("process.env.PORT");
  });

  test("configures the product runtime to use the bundled trust roots", () => {
    expect(dockerfile).toContain(`EMAILS_DATABASE_CA_FILE=${bundlePath}`);
    expect(dockerfile).toContain(`NODE_EXTRA_CA_CERTS=${bundlePath}`);
  });

  test("never disables certificate verification", () => {
    expect(dockerfile).not.toContain("NODE_TLS_REJECT_UNAUTHORIZED=0");
    expect(dockerfile).not.toContain("rejectUnauthorized: false");
  });
});

describe("self-hosted container install contract", () => {
  function hasSafePostinstallCopy(candidate: string): boolean {
    const postinstall = packageJson.scripts?.postinstall;
    if (typeof postinstall !== "string") return false;

    const scriptMatch = postinstall.match(/(?:^|\s)\.\/(scripts\/[^\s'"`]+)(?:\s|$)/);
    if (!scriptMatch) return false;
    const postinstallScript = scriptMatch[1];

    const dependenciesStart = candidate.search(/^FROM\s+\S+\s+AS\s+dependencies\s*$/m);
    const buildStart = candidate.search(/^FROM\s+\S+\s+AS\s+build\s*$/m);
    if (dependenciesStart < 0 || buildStart <= dependenciesStart) return false;

    const stageLines = candidate
      .slice(dependenciesStart, buildStart)
      .split("\n")
      .map((line) => line.trim());
    const installIndex = stageLines.indexOf("RUN bun install --production --frozen-lockfile");
    const copyIndex = stageLines.indexOf(`COPY ${postinstallScript} ./${postinstallScript}`);
    if (installIndex < 0 || copyIndex < 0 || copyIndex >= installIndex) return false;

    const workdirIndex = stageLines.findLastIndex(
      (line, index) => index < copyIndex && line.startsWith("WORKDIR "),
    );
    return stageLines[workdirIndex] === "WORKDIR /app";
  }

  test("copies the package postinstall script before the frozen production install", () => {
    expect(hasSafePostinstallCopy(dockerfile)).toBeTrue();
  });

  test("rejects external-stage and wrong-stage copy bypasses", () => {
    const safeCopy = "COPY scripts/ensure-private-data-dir.mjs ./scripts/ensure-private-data-dir.mjs";
    expect(
      hasSafePostinstallCopy(
        dockerfile.replace(safeCopy, `COPY --from=base ${safeCopy.slice("COPY ".length)}`),
      ),
    ).toBeFalse();
    expect(
      hasSafePostinstallCopy(
        dockerfile
          .replace(`${safeCopy}\nRUN bun install`, "RUN bun install")
          .replace("FROM base AS build\nWORKDIR /app", `FROM base AS build\nWORKDIR /app\n${safeCopy}`),
      ),
    ).toBeFalse();
  });
});
