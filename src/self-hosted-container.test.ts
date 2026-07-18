import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const dockerfile = readFileSync(resolve(import.meta.dir, "../Dockerfile"), "utf8");
const runtimeSmoke = readFileSync(
  resolve(import.meta.dir, "../scripts/container-runtime-smoke.sh"),
  "utf8",
);
const healthcheckCommand = dockerfile.match(
  /HEALTHCHECK[^\n]*\\\n\s*CMD (\[[^\n]+\])/,
)?.[1];
if (!healthcheckCommand) throw new Error("Dockerfile HEALTHCHECK command is missing");
const healthcheckScript = (JSON.parse(healthcheckCommand) as string[])[2];
if (!healthcheckScript) throw new Error("Dockerfile HEALTHCHECK script is missing");
const ecsCompute = readFileSync(
  resolve(import.meta.dir, "../deploy/aws/compute.tf"),
  "utf8",
);
const compose = readFileSync(
  resolve(import.meta.dir, "../docker-compose.yml"),
  "utf8",
);
const cutoverRunbook = readFileSync(
  resolve(import.meta.dir, "../docs/DEPLOYMENT_CUTOVER.md"),
  "utf8",
);
const packageJson = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../package.json"), "utf8"),
);
const bundlePath = "/opt/emails/certs/aws-rds-global-bundle.pem";
const bundleSha256 = "e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3";
const baseStage = dockerfile.slice(
  dockerfile.indexOf("FROM ${BUN_IMAGE} AS base"),
  dockerfile.indexOf("FROM base AS dependencies"),
);
const runtimeFilesStage = dockerfile.slice(
  dockerfile.indexOf("FROM base AS runtime-files"),
  dockerfile.indexOf("FROM scratch"),
);
const scratchStage = dockerfile.slice(dockerfile.indexOf("FROM scratch"));

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
    expect(runtimeFilesStage).toContain("cp -a /etc/alpine-release /runtime/etc/alpine-release");
  });

  test("applies and verifies exact reproducible OpenSSL security revisions in the shared base", () => {
    expect(baseStage).toContain("apk add --no-cache --upgrade");
    expect(baseStage).toContain("'libcrypto3=3.5.7-r0'");
    expect(baseStage).toContain("'libssl3=3.5.7-r0'");
    expect(baseStage).toContain("apk info --installed 'libcrypto3=3.5.7-r0'");
    expect(baseStage).toContain("apk info --installed 'libssl3=3.5.7-r0'");
    expect(baseStage).not.toContain("apk info --exists");
    expect(baseStage).not.toContain("libcrypto3>=");
    expect(baseStage).not.toContain("libssl3>=");
    expect(baseStage).not.toMatch(/\bapk upgrade\b/);
    expect(baseStage).not.toContain("rm -rf /var/cache/apk");
  });

  test("publishes scanner inventory for exactly the OS libraries copied into scratch", () => {
    expect(runtimeFilesStage).not.toContain(
      "cp -a /lib/apk/db/installed /runtime/lib/apk/db/installed",
    );
    expect(runtimeFilesStage).toContain('order[1] = "libgcc"');
    expect(runtimeFilesStage).toContain('order[2] = "libstdc++"');
    expect(runtimeFilesStage).toContain('order[3] = "musl"');
    expect(runtimeFilesStage).toContain('expected["libgcc"] = 1');
    expect(runtimeFilesStage).toContain('expected["libstdc++"] = 1');
    expect(runtimeFilesStage).toContain('expected["musl"] = 1');
    expect(runtimeFilesStage).toContain("if (name in records)");
    expect(runtimeFilesStage).toContain("if (!(name in records))");
    expect(runtimeFilesStage).toContain("if (failed) exit 1");
    expect(runtimeFilesStage).toContain('printf "%s\\n\\n", records[name]');
    expect(runtimeFilesStage).toContain(
      "/lib/apk/db/installed > /runtime/lib/apk/db/installed",
    );
    expect(runtimeFilesStage).not.toMatch(/expected\["(?:libcrypto3|libssl3)"\]/);
  });

  test("builds, retains, and cleans a separately tagged patched base target", () => {
    expect(runtimeSmoke).toContain(
      'patched_base_image="${CONTAINER_RUNTIME_PATCHED_BASE_IMAGE:-hasna-emails-patched-bun-base:${revision:0:12}}"',
    );
    expect(runtimeSmoke).toMatch(
      /docker build --platform linux\/amd64 \\\n+\s+--target base \\\n+\s+--tag "\$patched_base_image" \\\n+\s+--build-arg "BUN_IMAGE=\$upstream_image" \./,
    );
    expect(runtimeSmoke).toContain(
      'docker image rm -f "$image" "$patched_base_image" >/dev/null 2>&1 || true',
    );
    expect(runtimeSmoke.indexOf('--tag "$patched_base_image"')).toBeLessThan(
      runtimeSmoke.indexOf('--tag "$image"'),
    );
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
    expect(scratchStage).toContain("ARG VERSION=dev");
    expect(scratchStage).toContain("ARG REVISION=unknown");
    expect(scratchStage).toContain('org.opencontainers.image.source="https://github.com/hasna/emails"');
    expect(scratchStage).toContain('org.opencontainers.image.version="$VERSION"');
    expect(scratchStage).toContain('org.opencontainers.image.revision="$REVISION"');
    expect(scratchStage.match(/^COPY .+$/gm)).toEqual([
      "COPY --from=runtime-files /runtime/ /",
      "COPY --chown=1000:1000 --from=build /app/node_modules /app/node_modules",
      "COPY --chown=1000:1000 --from=build /app/package.json /app/package.json",
      "COPY --chown=1000:1000 --from=build /app/src /app/src",
    ]);
    expect(scratchStage).not.toContain("/app/node_modules ./node_modules");
    expect(scratchStage).not.toContain("/app/src ./src");
  });

  test("enforces exact runtime permissions and runtime user", () => {
    expect(runtimeFilesStage).toContain("/runtime/home/bun/.hasna/emails /runtime/etc");
    expect(runtimeFilesStage).toContain("printf '%s\\n' 'bun:x:1000:1000:Bun:/home/bun:/sbin/nologin' > /runtime/etc/passwd");
    expect(runtimeFilesStage).toContain("printf '%s\\n' 'bun:x:1000:' > /runtime/etc/group");
    expect(runtimeFilesStage).toContain("chmod 0644 /runtime/etc/passwd /runtime/etc/group");
    expect(dockerfile).toContain("chmod 1777 /runtime/tmp");
    expect(dockerfile).toContain('VOLUME ["/tmp"]');
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

  test("uses a bounded SQLite-backed probe for every accepted local mode spelling", async () => {
    expect(runtimeSmoke).toContain("--env EMAILS_MODE=local");
    expect(runtimeSmoke).toContain(
      'fetch("http://127.0.0.1:8080/api/providers?limit=1")',
    );
    expect(runtimeSmoke).not.toContain(
      'fetch("http://127.0.0.1:8080/ready")',
    );
    expect(healthcheckScript).toContain("?.trim().toLowerCase()");

    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
      ...args: string[]
    ) => (...args: unknown[]) => Promise<void>;
    const selectedUrl = async (mode?: string) => {
      let url: string | undefined;
      let exitCode: number | undefined;
      const env = mode === undefined ? { PORT: "8123" } : { EMAILS_MODE: mode, PORT: "8123" };
      await new AsyncFunction("process", "fetch", healthcheckScript)(
        { env, exit: (code: number) => { exitCode = code; } },
        async (input: string) => {
          url = input;
          return { ok: true };
        },
      );
      expect(exitCode).toBe(0);
      return url;
    };

    for (const mode of ["local", "LOCAL", "  LOCAL  ", "LoCaL"]) {
      expect(await selectedUrl(mode)).toBe("http://127.0.0.1:8123/api/providers?limit=1");
    }
    for (const mode of [undefined, "self_hosted", " SELF_HOSTED "]) {
      expect(await selectedUrl(mode)).toBe("http://127.0.0.1:8123/ready");
    }
  });

  test("runs readiness inside the existing non-root service container", () => {
    const readinessLoop = runtimeSmoke.slice(
      runtimeSmoke.indexOf('for _ in $(seq 1 "$readiness_attempts"); do'),
      runtimeSmoke.indexOf('if test "$ready" != "1"; then'),
    );

    expect(readinessLoop).toContain(
      'if docker exec "$container" /usr/local/bin/bun -e \'',
    );
    expect(readinessLoop).not.toContain("docker run");
    expect(readinessLoop).not.toContain('--network "container:$container"');
  });

  test("mounts a private writable SQLite directory for the read-only local runtime", () => {
    const serviceRunStart = runtimeSmoke.indexOf("docker run --detach");
    const serviceRun = runtimeSmoke.slice(
      serviceRunStart,
      runtimeSmoke.indexOf('"$image" >/dev/null', serviceRunStart),
    );

    expect(serviceRun).toContain("--read-only");
    expect(serviceRun).toContain(
      "--tmpfs /app/data:rw,noexec,nosuid,nodev,mode=0700,uid=1000,gid=1000",
    );
    expect(serviceRun).toContain("--env EMAILS_DB_PATH=/app/data/emails.db");
    expect(runtimeSmoke).not.toContain("/tmp/emails.db");
  });

  test("allows the readiness probe to outlive the image cold-start health cadence", () => {
    const healthConfig = dockerfile.match(
      /HEALTHCHECK --interval=(\d+)s --timeout=(\d+)s --start-period=(\d+)s/,
    );
    if (!healthConfig) throw new Error("Dockerfile health timing is missing");

    const healthIntervalSeconds = Number(healthConfig[1]);
    const healthTimeoutSeconds = Number(healthConfig[2]);
    const healthStartPeriodSeconds = Number(healthConfig[3]);
    const smokeTiming = Object.fromEntries(
      [...runtimeSmoke.matchAll(
        /^(image_health_(?:interval|timeout|start_period)_seconds)=(\d+)$/gm,
      )].map((match) => [match[1], Number(match[2])]),
    );

    expect(smokeTiming).toEqual({
      image_health_interval_seconds: healthIntervalSeconds,
      image_health_timeout_seconds: healthTimeoutSeconds,
      image_health_start_period_seconds: healthStartPeriodSeconds,
    });
    expect(runtimeSmoke).toMatch(
      /readiness_wait_seconds=\$\(\(\s*image_health_start_period_seconds\s*\+ \(2 \* image_health_interval_seconds\)\s*\+ \(2 \* image_health_timeout_seconds\)\s*\)\)/,
    );
    expect(runtimeSmoke).toContain('health_wait_seconds="$readiness_wait_seconds"');

    const readinessBudgetSeconds = healthStartPeriodSeconds
      + (2 * healthIntervalSeconds)
      + (2 * healthTimeoutSeconds);
    const healthBudgetSeconds = readinessBudgetSeconds;

    expect(readinessBudgetSeconds).toBe(90);
    expect(healthBudgetSeconds).toBe(90);
    expect(readinessBudgetSeconds).toBeGreaterThanOrEqual(
      healthStartPeriodSeconds + healthIntervalSeconds,
    );
    expect(healthBudgetSeconds).toBeGreaterThan(healthIntervalSeconds);
    expect(runtimeSmoke).toContain(
      "readiness_attempts=$((readiness_wait_seconds / readiness_poll_interval_seconds))",
    );
    expect(runtimeSmoke).toContain(
      "health_attempts=$((health_wait_seconds / health_poll_interval_seconds))",
    );
    expect(runtimeSmoke).not.toMatch(
      /if test "\$health" = "unhealthy"; then\s*break\s*fi/,
    );
    expect(runtimeSmoke).toContain('if test "$health" != "healthy"; then');
  });

  test("keeps ECS commands compatible with the Bun image entrypoint", () => {
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/bun"]');
    expect(ecsCompute).toContain('command                = ["src/server/index.ts"]');
    expect(ecsCompute).toContain(
      'command                = ["src/server/index.ts", "ingest-worker"]',
    );
    expect(ecsCompute).toContain(
      'command                = ["src/cli/index.tsx", "db", "migrate"]',
    );
    expect(ecsCompute).not.toMatch(/^\s*command\s*=\s*\["bun",/m);
  });

  test("keeps Compose and cutover overrides compatible with the Bun image entrypoint", () => {
    expect(compose).toContain('command: ["src/server/index.ts"]');
    expect(compose).toContain(
      'command: ["src/cli/index.tsx", "db", "migrate"]',
    );
    expect(cutoverRunbook).toContain(
      '"command":["src/server/index.ts","inbound-provenance-fence"]',
    );
    expect(cutoverRunbook).toContain(
      'command:["src/cli/index.tsx","--json","db","status"]',
    );
    expect(cutoverRunbook).toContain(
      'command:["src/server/index.ts","inbound-provenance-audit","--since",$since]',
    );
    for (const source of [compose, cutoverRunbook]) {
      expect(source).not.toMatch(
        /(?:"command"|command)\s*:\s*\[\s*"bun"/,
      );
    }
  });

  test("keeps the ECS health check executable without a shell", () => {
    expect(dockerfile).toContain("FROM scratch");
    expect(ecsCompute).not.toContain('command     = ["CMD-SHELL"');
    expect(ecsCompute).toContain(
      'command     = ["CMD", "/usr/local/bin/bun", "-e",',
    );
    expect(ecsCompute).toContain("/ready");
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
