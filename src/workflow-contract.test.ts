import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const workflowDir = join(import.meta.dir, "..", ".github", "workflows");

describe("repository workflow safety", () => {
  it("allows only product CI and credential-free Terraform validation", () => {
    const files = existsSync(workflowDir)
      ? readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name)).sort()
      : [];
    const text = files.map((name) => readFileSync(join(workflowDir, name), "utf8")).join("\n");
    expect(files).toEqual(["ci.yml", "terraform-aws-validate.yml"]);
    expect(text).not.toMatch(
      /configure-aws-credentials|aws-actions\/amazon-ecr|amazon-ecr-login|ecs update-service|aws configure|role-to-assume|id-token:\s*write/i,
    );
    expect(text).not.toMatch(/^\s*(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)\s*:/m);
    expect(text).not.toMatch(/\b(?:terraform|tofu)\s+(?:apply|destroy)\b/i);
    expect(text).not.toMatch(/\b(?:npm|bun|pnpm|yarn)\s+publish\b/i);
  });

  it("keeps both product CI jobs on the reviewed Bun toolchain", () => {
    const ci = readFileSync(join(workflowDir, "ci.yml"), "utf8");
    expect(ci.match(/bun-version:\s*1\.3\.14/g)).toHaveLength(2);
    expect(ci).not.toContain("bun-version: 1.3.13");
  });

  it("scans the locally patched Bun base without weakening either vulnerability gate", () => {
    const ci = readFileSync(join(workflowDir, "ci.yml"), "utf8");
    expect(ci).toContain(
      "BUN_UPSTREAM_IMAGE: oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0",
    );
    expect(ci).toContain(
      "CONTAINER_RUNTIME_PATCHED_BASE_IMAGE: hasna-emails-patched-bun-base:ci",
    );
    expect(ci.match(/image-ref: \$\{\{ env\.CONTAINER_RUNTIME_PATCHED_BASE_IMAGE \}\}/g)).toHaveLength(2);
    expect(ci).not.toContain("image-ref: ${{ env.BUN_UPSTREAM_IMAGE }}");
    expect(ci).toContain("trivy-patched-bun-base-report.json");
    expect(ci).toContain(
      'and (([.Results[]? | select(.Class == "os-pkgs") | .Packages[]? | .Name] | unique | sort) == ["libgcc", "libstdc++", "musl"])',
    );
    expect(ci).toContain(
      'and (([.Results[]? | select(.Class == "lang-pkgs") | .Packages[]?] | length) > 0)',
    );
    expect(
      ci.match(/and \(\(\[\.Results\[\]\? \| select\(\.Class == "os-pkgs"\) \| \.Packages\[\]\?\] \| length\) > 0\)/g),
    ).toHaveLength(1);
    expect(ci.match(/severity: CRITICAL,HIGH/g)).toHaveLength(2);
    expect(ci.match(/ignore-unfixed: "false"/g)).toHaveLength(4);
    expect(ci).not.toMatch(/ignorefile|skip-files|skip-dirs|trivyignores|vex/i);
    expect(ci).toContain(
      "docker image rm -f hasna-emails-runtime-contract:ci hasna-emails-patched-bun-base:ci || true",
    );
  });
});
