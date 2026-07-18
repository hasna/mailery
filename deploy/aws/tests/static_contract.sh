#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
repo=$(CDPATH= cd -- "$root/../.." && pwd)
cd "$root"
dockerfile="$repo/Dockerfile"

if ! grep -Fq 'ARG BUN_IMAGE=oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0' "$dockerfile"; then
  echo "self-hosted container must pin the Alpine Bun image digest" >&2
  exit 1
fi

if grep -Eiq '(^|[[:space:]])(apt-get|\bdpkg\b|\bglibc\b|\bperl\b|\bsqlite\b|OPENSSL_VERSION)' "$dockerfile"; then
  echo "self-hosted container contract forbids Debian package tooling and legacy runtime dependencies" >&2
  exit 1
fi

if ! grep -Fxq 'FROM scratch' "$dockerfile"; then
  echo "self-hosted container must end in a scratch runtime" >&2
  exit 1
fi

if grep -Eq '^FROM[[:space:]]+base[[:space:]]+AS[[:space:]]+runtime[[:space:]]*$' "$dockerfile"; then
  echo "self-hosted runtime must not keep a non-scratch intermediate final runtime stage" >&2
  exit 1
fi

if grep -Fq 'locale-archive' "$dockerfile"; then
  echo "self-hosted container may not include locale fallback copy steps" >&2
  exit 1
fi

if grep -Fq '|| true' "$dockerfile"; then
  echo "self-hosted container may not contain permissive fallback copy commands" >&2
  exit 1
fi

if ! grep -Fq 'PATH=/usr/local/bin' "$dockerfile"; then
  echo "self-hosted runtime must include /usr/local/bin on PATH" >&2
  exit 1
fi

if ! grep -Fq 'ln -sf bun /runtime/usr/local/bin/bunx' "$dockerfile"; then
  echo "self-hosted runtime must expose bunx shim" >&2
  exit 1
fi

if ! grep -Fq 'ln -sf bun /runtime/usr/local/bin/node' "$dockerfile"; then
  echo "self-hosted runtime must expose node shim" >&2
  exit 1
fi

expected_scratch_copies='COPY --from=runtime-files /runtime/ /
COPY --chown=1000:1000 --from=build /app/node_modules /app/node_modules
COPY --chown=1000:1000 --from=build /app/package.json /app/package.json
COPY --chown=1000:1000 --from=build /app/src /app/src'
actual_scratch_copies=$(awk '/^FROM scratch$/ { scratch = 1; next } scratch && /^COPY / { print }' "$dockerfile")
if [ "$actual_scratch_copies" != "$expected_scratch_copies" ]; then
  echo "scratch runtime COPY instructions must match the exact runtime and build allowlist" >&2
  exit 1
fi

for image_metadata_contract in \
  'ARG VERSION=dev' \
  'ARG REVISION=unknown' \
  'org.opencontainers.image.source="https://github.com/hasna/emails"' \
  'org.opencontainers.image.version="$VERSION"' \
  'org.opencontainers.image.revision="$REVISION"'; do
  if ! grep -Fq "$image_metadata_contract" "$dockerfile"; then
    echo "missing immutable image metadata contract: $image_metadata_contract" >&2
    exit 1
  fi
done

runtime_files_stage=$(awk '/^FROM base AS runtime-files$/ { runtime = 1 } /^FROM scratch$/ { runtime = 0 } runtime { print }' "$dockerfile")

for scanner_inventory_contract in \
  'cp -a /etc/alpine-release /runtime/etc/alpine-release' \
  'order[1] = "libgcc"' \
  'order[2] = "libstdc++"' \
  'order[3] = "musl"' \
  'expected["libgcc"] = 1' \
  'expected["libstdc++"] = 1' \
  'expected["musl"] = 1' \
  'if (name in records)' \
  'if (!(name in records))' \
  'if (failed) exit 1' \
  'printf "%s\n\n", records[name]' \
  '/lib/apk/db/installed > /runtime/lib/apk/db/installed'; do
  if ! printf '%s\n' "$runtime_files_stage" | grep -Fq "$scanner_inventory_contract"; then
    echo "scratch runtime must preserve its exact Alpine scanner inventory: $scanner_inventory_contract" >&2
    exit 1
  fi
done

if printf '%s\n' "$runtime_files_stage" | grep -Fq 'cp -a /lib/apk/db/installed /runtime/lib/apk/db/installed'; then
  echo "scratch runtime scanner inventory must exclude packages absent from the final image" >&2
  exit 1
fi

for exact_openssl_revision in \
  "'libcrypto3=3.5.7-r0'" \
  "'libssl3=3.5.7-r0'" \
  "apk info --installed 'libcrypto3=3.5.7-r0'" \
  "apk info --installed 'libssl3=3.5.7-r0'"; do
  if ! grep -Fq "$exact_openssl_revision" "$dockerfile"; then
    echo "patched base must install and verify exact OpenSSL revisions: $exact_openssl_revision" >&2
    exit 1
  fi
done

if grep -Fq 'apk info --exists' "$dockerfile"; then
  echo "patched base must not use the unsupported apk info --exists flag" >&2
  exit 1
fi

if grep -Eq 'lib(crypto|ssl)3>=' "$dockerfile"; then
  echo "patched base OpenSSL constraints must be exact, not minimum floors" >&2
  exit 1
fi

for runtime_identity in \
  "/runtime/home/bun/.hasna/emails /runtime/etc" \
  "printf '%s\\n' 'bun:x:1000:1000:Bun:/home/bun:/sbin/nologin' > /runtime/etc/passwd" \
  "printf '%s\\n' 'bun:x:1000:' > /runtime/etc/group" \
  "chmod 0644 /runtime/etc/passwd /runtime/etc/group"; do
  if ! printf '%s\n' "$runtime_files_stage" | grep -Fq "$runtime_identity"; then
    echo "missing required scratch runtime identity contract: $runtime_identity" >&2
    exit 1
  fi
done

if ! grep -Fq 'chmod 1777 /runtime/tmp' "$dockerfile" || ! grep -Fq 'chmod 0700 /runtime/home/bun/.hasna/emails' "$dockerfile"; then
  echo "self-hosted runtime must harden tmp and private state permissions" >&2
  exit 1
fi

if ! grep -Fq 'VOLUME ["/tmp"]' "$dockerfile"; then
  echo "ECS /tmp mount must inherit image permissions through a Dockerfile VOLUME" >&2
  exit 1
fi

if ! grep -Fq 'chown -R 1000:1000 /runtime/home/bun /runtime/home/bun/.hasna/emails /runtime/app /runtime/app/data' "$dockerfile"; then
  echo "self-hosted runtime must chown runtime ownership for bun home and app data" >&2
  exit 1
fi

if ! grep -Fq 'USER 1000:1000' "$dockerfile"; then
  echo "self-hosted container must run as numeric user 1000:1000" >&2
  exit 1
fi

if grep -Eq '"?command"?[[:space:]]*[:=][[:space:]]*\[[[:space:]]*"bun"' \
  "$root/compute.tf" "$repo/docker-compose.yml" "$repo/docs/DEPLOYMENT_CUTOVER.md"; then
  echo "container command overrides must not repeat the Bun image entrypoint" >&2
  exit 1
fi

if find . -type f \
  ! -path './tests/*' \
  ! -path './.terraform/*' \
  -exec grep -Ein 'hasna[.]xyz|mailery[.]co|MAILERY|HASNA_EMAILS|HASNA_MAILERY|API_KEY_SIGNING_SECRET' {} \; \
  | grep -q .; then
  echo "forbidden hosted-service coupling found" >&2
  exit 1
fi

if grep -En 'name[[:space:]]*=[[:space:]]*"DATABASE_URL"|\["mailery|\["mailery-serve' compute.tf >/dev/null; then
  echo "legacy command or generic secret environment found" >&2
  exit 1
fi

worker_statement_is_gated() {
  awk -v wanted_sid="$1" '
    function brace_delta(value, copy, opens, closes) {
      copy = value
      opens = gsub(/\{/, "", copy)
      copy = value
      closes = gsub(/\}/, "", copy)
      return opens - closes
    }

    /^[[:space:]]*dynamic[[:space:]]+"statement"[[:space:]]*\{/ {
      in_statement = 1
      depth = 0
      gated = 0
      matched_sid = 0
    }

    in_statement {
      if ($0 ~ /^[[:space:]]*for_each[[:space:]]*=[[:space:]]*var[.]enable_ses_inbound/) {
        gated = 1
      }
      sid_pattern = "sid[[:space:]]*=[[:space:]]*\"" wanted_sid "\""
      if ($0 ~ sid_pattern) {
        matched_sid = 1
      }
      depth += brace_delta($0)
      if (depth == 0) {
        if (gated && matched_sid) {
          found = 1
        }
        in_statement = 0
      }
    }

    END { exit found ? 0 : 1 }
  ' iam.tf
}

for sid in ReadInboundBucket ReadInboundObjects ConsumeInboundQueue DecryptInboundData; do
  if ! worker_statement_is_gated "$sid"; then
    echo "worker permission $sid is not gated by enable_ses_inbound" >&2
    exit 1
  fi
done

if find . -type f \
  ! -path './tests/*' \
  ! -path './examples/*' \
  ! -path './.terraform/*' \
  -exec grep -En 'arn:aws:[a-z0-9-]+:[a-z0-9-]*:[0-9]{12}' {} \; \
  | grep -q .; then
  echo "concrete AWS account ARN found outside test/example fixtures" >&2
  exit 1
fi

if find . -type f -name '*.tf' \
  -exec grep -En 'resource[[:space:]]+"aws_ses_active_receipt_rule_set"' {} \; \
  | grep -q .; then
  echo "Terraform must not activate the account-global SES receipt rule set" >&2
  exit 1
fi

if find . -type f -name '*.tf' \
  -exec grep -En 'resource[[:space:]]+"aws_secretsmanager_secret_version"' {} \; \
  | grep -q .; then
  echo "Terraform must not place secret values in state" >&2
  exit 1
fi

if grep -En '^[[:space:]]+(ingress|egress)[[:space:]]*\{' network.tf >/dev/null; then
  echo "inline security-group rules are forbidden; use standalone rule resources" >&2
  exit 1
fi

rollback_assignments="$(grep -Fc 'rollback = var.enable_automatic_deployment_rollback' compute.tf || true)"
if [ "$rollback_assignments" != "2" ]; then
  echo "API and worker rollback must both use the explicit automatic-rollback gate" >&2
  exit 1
fi

for cutover_output in \
  'output "api_service_name"' \
  'output "worker_service_name"' \
  'output "api_task_definition_arn"' \
  'output "worker_task_definition_arn"'; do
  grep -Fq "$cutover_output" outputs.tf || {
    echo "safe 0017 cutover output missing: $cutover_output" >&2
    exit 1
  }
done

rollback_migration_guards="$(grep -Fc '!var.enable_automatic_deployment_rollback || var.migrations_complete' compute.tf || true)"
if [ "$rollback_migration_guards" != "2" ]; then
  echo "API and worker must both reject automatic rollback before migrations_complete" >&2
  exit 1
fi

if ! awk '
  /^variable "enable_automatic_deployment_rollback" \{/ { in_variable = 1; depth = 0; safe_default = 0 }
  in_variable {
    depth += gsub(/\{/, "{") - gsub(/\}/, "}")
    if ($0 ~ /^[[:space:]]*default[[:space:]]*=[[:space:]]*false[[:space:]]*$/) safe_default = 1
    if (depth == 0) exit safe_default ? 0 : 1
  }
  END { if (!in_variable) exit 1 }
' variables.tf; then
  echo "automatic deployment rollback must default to false for the sealed cutover" >&2
  exit 1
fi

if grep -En 'http://' outputs.tf >/dev/null; then
  echo "client endpoint outputs must be HTTPS-only" >&2
  exit 1
fi

if find . -type f -name '*.tf' \
  -exec grep -En '^check[[:space:]]+"' {} \; \
  | grep -q .; then
  echo "nonblocking Terraform check blocks are forbidden for safety contracts" >&2
  exit 1
fi

workflow_dir="$repo/.github/workflows"
workflow="$workflow_dir/terraform-aws-validate.yml"
product_workflow="$workflow_dir/ci.yml"
test -f "$workflow" || { echo "CI-safe Terraform workflow missing" >&2; exit 1; }
test -f "$product_workflow" || { echo "product CI workflow missing" >&2; exit 1; }

workflow_count="$(find "$workflow_dir" -maxdepth 1 -type f \( -name '*.yml' -o -name '*.yaml' \) | wc -l | tr -d '[:space:]')"
if [ "$workflow_count" != "2" ]; then
  echo "only ci.yml and terraform-aws-validate.yml are allowed" >&2
  exit 1
fi

grep -Fq '".github/workflows/**"' "$workflow" || {
  echo "workflow changes must trigger the static legacy-workflow guard" >&2
  exit 1
}

grep -Fq 'terraform providers lock -platform=darwin_arm64 -platform=linux_amd64' "$workflow" || {
  echo "Terraform CI must verify both development and hosted-runner provider checksums" >&2
  exit 1
}

if grep -En 'id-token:[[:space:]]*write|configure-aws-credentials|amazon-ecr-login|role-to-assume|aws configure' \
  "$workflow" "$product_workflow" >/dev/null; then
  echo "workflows must not request AWS credentials or OIDC" >&2
  exit 1
fi

if grep -En '^[[:space:]]*(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)[[:space:]]*:' \
  "$workflow" "$product_workflow" >/dev/null; then
  echo "workflows must not provide AWS credential environment values" >&2
  exit 1
fi

if grep -En '(^|[^[:alnum:]_])(terraform|tofu)[[:space:]]+(apply|destroy)([^[:alnum:]_-]|$)|(^|[^[:alnum:]_])(npm|bun|pnpm|yarn)[[:space:]]+publish([^[:alnum:]_-]|$)|ecs[[:space:]]+update-service' \
  "$workflow" "$product_workflow" >/dev/null; then
  echo "workflows must not apply, destroy, publish, or deploy" >&2
  exit 1
fi

for allowed_workflow in "$workflow" "$product_workflow"; do
  uses_count="$(grep -Ec 'uses:' "$allowed_workflow" || true)"
  pinned_uses_count="$(grep -Ec 'uses:[[:space:]]+[^@[:space:]]+@[0-9a-f]{40}([[:space:]]+#.*)?$' "$allowed_workflow" || true)"
  if [ "$uses_count" != "$pinned_uses_count" ]; then
    echo "every workflow action must be pinned to an immutable commit SHA" >&2
    exit 1
  fi
done

for runbook in "$repo/docs/DEPLOYMENT_CUTOVER.md" "$root/README.md"; do
  for phrase in \
    "migration 0016" \
    "every old API, worker, ingest" \
    "Drain and stop all of them" \
    "new-code-compatible migrator" \
    "Start only tenant-aware new-code writers" \
    "pre-tenancy" \
    "unscoped image" \
    "Roll forward" \
    "enable_automatic_deployment_rollback = false" \
    "enable_automatic_deployment_rollback = true"; do
    grep -Fiq "$phrase" "$runbook" || {
      echo "tenant-sealing migration contract missing '$phrase' from $runbook" >&2
      exit 1
    }
  done
done

cutover_text="$(tr '\n' ' ' < "$repo/docs/DEPLOYMENT_CUTOVER.md")"
if grep -En '(^|[^[:digit:]])[[:digit:]]+[.][[:digit:]]+[.][[:digit:]]+([^[:digit:]]|$)|IMAGE_[[:digit:]]+' \
  "$repo/docs/DEPLOYMENT_CUTOVER.md" >/dev/null; then
  echo "0017 runbook must use release inputs instead of stale hardcoded release literals" >&2
  exit 1
fi

for source_contract in \
  'applied: string[]' \
  'alreadyApplied: string[]' \
  'pending: string[]' \
  'const ledger = new MigrationLedger(client, migrations)' \
  'const result = await ledger.migrate({ dryRun: opts.dryRun === true })'; do
  grep -Fq "$source_contract" "$repo/src/server/self-hosted/migrate.ts" || {
    echo "db status source contract missing '$source_contract'" >&2
    exit 1
  }
done
grep -Fq 'Migration checksum mismatch' "$repo/src/storage-kit/migrations.ts" || {
  echo "db status must fail before JSON output when an applied checksum is invalid" >&2
  exit 1
}

for phrase in \
  "migration 0017" \
  "SOURCE_CHECKOUT" \
  "RELEASE_VERSION" \
  "RELEASE_COMMIT" \
  "SOURCE_ARCHIVE_SHA256" \
  "IMAGE_REPOSITORY" \
  "IMAGE_DIGEST" \
  "IMAGE_REFERENCE" \
  'test "$IMAGE_REFERENCE" = "${IMAGE_REPOSITORY}@${IMAGE_DIGEST}"' \
  'git -C "$SOURCE_CHECKOUT" archive --format=zip "$RELEASE_COMMIT"' \
  'git -C "$SOURCE_CHECKOUT" show "$RELEASE_COMMIT:package.json"' \
  'org.opencontainers.image.revision' \
  'org.opencontainers.image.version' \
  "controlled downtime" \
  "old worker and API are both at zero" \
  "SQS buffers" \
  "FENCE_AT" \
  "inbound-provenance-fence" \
  "INITIAL_DLQ_VISIBLE" \
  "INITIAL_DLQ_IN_FLIGHT" \
  "DLQ_STABLE_READS" \
  "FENCE_LOG_EVENTS" \
  "STATUS_LOG_EVENTS" \
  "STATUS_LOG_STREAM" \
  'select((keys | sort) == ["fence_at"])' \
  'select((keys | sort) == ["alreadyApplied","applied","pending"])' \
  '(.pending | type == "array" and length == 0)' \
  '(.alreadyApplied | index("0017_inbound_message_source_provenance") != null)' \
  'test "$FENCE_EXIT" = "0"' \
  'test "$MIGRATION_EXIT" = "0"' \
  'test "$STATUS_EXIT" = "0"' \
  'test "$AUDIT_EXIT" = "0"' \
  'test "$INITIAL_DLQ_VISIBLE" = "0"' \
  'test "$INITIAL_DLQ_IN_FLIGHT" = "0"' \
  'test "$FINAL_DLQ_VISIBLE" = "0"' \
  'test "$FINAL_DLQ_IN_FLIGHT" = "0"' \
  "verify ledger 0017" \
  "inbound-provenance-audit" \
  "only the release worker" \
  "before the API" \
  "compatible roll-forward" \
  "pre-0017 release"; do
  printf '%s\n' "$cutover_text" | grep -Fiq "$phrase" || {
    echo "0017 forward-only cutover contract missing '$phrase' from docs/DEPLOYMENT_CUTOVER.md" >&2
    exit 1
  }
done

for phrase in \
  "UNUSABLE for" \
  "actual live topology" \
  "Never run, copy, or paste" \
  "separately generated and independently reviewed AWS CLI plan" \
  "cloned from the exact live service task definitions" \
  "LIVE_TOPOLOGY_MANIFEST" \
  "LIVE_TOPOLOGY_SHA256" \
  "LIVE_API_TASK_FAMILY" \
  "LIVE_WORKER_TASK_FAMILY" \
  "LIVE_MIGRATION_TASK_FAMILY" \
  "LIVE_RUNTIME_ARCHITECTURE" \
  "LIVE_IMAGE_REPOSITORY" \
  "LIVE_IMAGE_REFERENCE" \
  "MANIFEST_API_CONTAINER_NAME" \
  "MANIFEST_WORKER_CONTAINER_NAME" \
  "MANIFEST_MIGRATION_CONTAINER_NAME" \
  "MANIFEST_API_TASK_ROLE_ARN" \
  "MANIFEST_WORKER_TASK_ROLE_ARN" \
  "MANIFEST_MIGRATION_TASK_ROLE_ARN" \
  "MANIFEST_API_EXECUTION_ROLE_ARN" \
  "MANIFEST_WORKER_EXECUTION_ROLE_ARN" \
  "MANIFEST_MIGRATION_EXECUTION_ROLE_ARN" \
  "X86_64" \
  "database-specific" \
  "NO_SES_SMOKE_TASK_ROLE_ARN" \
  "outbound sending" \
  "bootstrap" \
  "separate explicit approval" \
  "imported or adopted" \
  "no-op plan" \
  "RUNBOOK_MODE" \
  "isolated-rehearsal" \
  "REHEARSAL_NAME" \
  "REHEARSAL_ACCOUNT_ID" \
  "REHEARSAL_TOPOLOGY_MANIFEST" \
  "REHEARSAL_TOPOLOGY_SHA256" \
  "reviewed topology manifest" \
  "exact schema" \
  '.environment == "rehearsal"' \
  '.live == false' \
  "require_isolated_rehearsal" \
  "rehearsal_terraform" \
  "rehearsal_aws"; do
  printf '%s\n' "$cutover_text" | grep -Fiq "$phrase" || {
    echo "0017 live-topology safety contract missing '$phrase' from docs/DEPLOYMENT_CUTOVER.md" >&2
    exit 1
  }
done

plan_count="$(grep -Fc 'rehearsal_terraform plan' "$repo/docs/DEPLOYMENT_CUTOVER.md")"
image_plan_count="$(grep -Fc -- '-var="container_image=$IMAGE_REFERENCE"' "$repo/docs/DEPLOYMENT_CUTOVER.md")"
architecture_plan_count="$(grep -Fc -- '-var="container_architecture=X86_64"' "$repo/docs/DEPLOYMENT_CUTOVER.md")"
if test "$plan_count" -eq 0 || test "$image_plan_count" != "$plan_count" || \
  test "$architecture_plan_count" != "$plan_count"; then
  echo "every Terraform plan must use the full immutable image reference and X86_64" >&2
  exit 1
fi
if grep -Fq -- '-var="container_image=$IMAGE_DIGEST"' "$repo/docs/DEPLOYMENT_CUTOVER.md"; then
  echo "a bare digest must never be passed as Terraform container_image" >&2
  exit 1
fi
for staged_assertion in \
  'assert_staged_task_definition "$STAGED_MIGRATION_TASK_JSON" "$MIGRATION_DEF"' \
  'assert_staged_task_definition "$STAGED_WORKER_TASK_JSON" "$WORKER_DEF"' \
  'assert_staged_task_definition "$STAGED_API_TASK_JSON" "$API_DEF"'; do
  test "$(grep -Fc "$staged_assertion" "$repo/docs/DEPLOYMENT_CUTOVER.md")" = "1" || {
    echo "each staged migration, worker, and API definition needs one exact metadata assertion" >&2
    exit 1
  }
done

if ! awk '
  /^```bash[[:space:]]*$/ { in_bash = 1; need_strict_mode = 1; next }
  /^```[[:space:]]*$/ && in_bash { in_bash = 0; need_strict_mode = 0; next }
  in_bash && need_strict_mode && /^[[:space:]]*$/ { next }
  in_bash && need_strict_mode {
    if ($0 != "set -euo pipefail") exit 1
    need_strict_mode = 0
  }
  END { if (need_strict_mode) exit 1 }
' "$repo/docs/DEPLOYMENT_CUTOVER.md"; then
  echo "every executable Bash block must start with set -euo pipefail" >&2
  exit 1
fi

if grep -En '^[[:space:]]*(terraform[[:space:]]+(plan|apply)|aws[[:space:]]+ecs[[:space:]]+(run-task|update-service))([[:space:]]|$)' \
  "$repo/docs/DEPLOYMENT_CUTOVER.md" >/dev/null; then
  echo "0017 runbook contains an unguarded copy/paste-capable Terraform or ECS mutation" >&2
  exit 1
fi

for guarded_command in \
  'rehearsal_terraform plan' \
  'rehearsal_terraform apply' \
  'rehearsal_aws ecs run-task' \
  'rehearsal_aws ecs update-service'; do
  grep -Fq "$guarded_command" "$repo/docs/DEPLOYMENT_CUTOVER.md" || {
    echo "0017 rehearsal wrapper missing '$guarded_command' from docs/DEPLOYMENT_CUTOVER.md" >&2
    exit 1
  }
done

guard_line="$(grep -nF 'require_isolated_rehearsal() {' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
manifest_hash_line="$(grep -nF 'sha256sum -- "$REHEARSAL_TOPOLOGY_MANIFEST"' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
manifest_schema_line="$(grep -nF '(keys | sort) == $expected_keys' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
source_package_line="$(grep -nF 'git -C "$SOURCE_CHECKOUT" show "$RELEASE_COMMIT:package.json"' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
source_archive_line="$(grep -nF 'git -C "$SOURCE_CHECKOUT" archive --format=zip "$RELEASE_COMMIT"' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
service_preflight_line="$(grep -nF 'SERVICE_PREFLIGHT_JSON=' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
image_details_line="$(grep -nF 'IMAGE_DETAILS_JSON=' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
image_report_gate_line="$(grep -nF '.ArtifactName == $image_reference' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
image_report_digest_line="$(grep -nF '.Metadata.RepoDigests | type == "array" and index($image_reference) != null' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
image_severity_gate_line="$(grep -nF 'select(.Severity == "CRITICAL" or .Severity == "HIGH")' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
image_sbom_gate_line="$(grep -nF '.bomFormat == "CycloneDX"' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
image_sbom_digest_line="$(grep -nF 'aquasecurity:trivy:RepoDigest' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
image_config_line="$(grep -nF 'IMAGE_CONFIG_JSON=' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
image_metadata_gate_line="$(grep -nF '.config.Labels["org.opencontainers.image.revision"] == $release_commit' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
queue_identity_line="$(grep -nF 'deadLetterTargetArn == $dlq_arn' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
initial_dlq_zero_line="$(grep -nF 'test "$INITIAL_DLQ_VISIBLE" = "0"' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
first_plan_line="$(grep -nF 'rehearsal_terraform plan' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
first_mutation_line="$(grep -nE 'rehearsal_(terraform (plan|apply)|aws ecs (run-task|update-service))' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
for safety_line in \
  "$guard_line" \
  "$manifest_hash_line" \
  "$manifest_schema_line" \
  "$source_package_line" \
  "$source_archive_line" \
  "$service_preflight_line" \
  "$image_details_line" \
  "$image_report_gate_line" \
  "$image_report_digest_line" \
  "$image_severity_gate_line" \
  "$image_sbom_gate_line" \
  "$image_sbom_digest_line" \
  "$image_config_line" \
  "$image_metadata_gate_line" \
  "$queue_identity_line" \
  "$initial_dlq_zero_line"; do
  test -n "$safety_line" || {
    echo "0017 reviewed-topology preflight is incomplete" >&2
    exit 1
  }
  test "$safety_line" -lt "$first_plan_line" && test "$safety_line" -lt "$first_mutation_line" || {
    echo "0017 reviewed-topology preflight must complete before every executable planning or mutation path" >&2
    exit 1
  }
done

if ! grep -Fq './scripts/container-runtime-smoke.sh' "$repo/.github/workflows/ci.yml"; then
  echo "CI must build and exercise the scratch runtime image" >&2
  exit 1
fi

for scanner_contract in \
  'aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25' \
  'BUN_UPSTREAM_IMAGE: oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0' \
  'CONTAINER_RUNTIME_PATCHED_BASE_IMAGE: hasna-emails-patched-bun-base:ci' \
  'format: json' \
  'format: cyclonedx' \
  'list-all-pkgs: "true"' \
  '.Metadata.OS.Family == "alpine"' \
  'select(.Class == "os-pkgs") | .Packages[]?' \
  'select(.Class == "os-pkgs") | .Packages[]? | .Name] | unique | sort) == ["libgcc", "libstdc++", "musl"]' \
  'select(.Class == "lang-pkgs") | .Packages[]?' \
  'trivy-patched-bun-base-report.json' \
  'image-ref: ${{ env.CONTAINER_RUNTIME_PATCHED_BASE_IMAGE }}' \
  'severity: CRITICAL,HIGH' \
  'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02'; do
  if ! grep -Fq "$scanner_contract" "$repo/.github/workflows/ci.yml"; then
    echo "missing pinned scanner/SBOM evidence contract: $scanner_contract" >&2
    exit 1
  fi
done

for exact_image_evidence in \
  'IMAGE_SECURITY_REPORT' \
  'IMAGE_SECURITY_REPORT_SHA256' \
  'IMAGE_SBOM' \
  'IMAGE_SBOM_SHA256'; do
  if ! grep -Fq "$exact_image_evidence" "$repo/docs/DEPLOYMENT_CUTOVER.md"; then
    echo "cutover must require exact-image scanner and SBOM evidence: $exact_image_evidence" >&2
    exit 1
  fi
done

if ! grep -Fq 'test "$FINAL_DLQ_VISIBLE" = "0"' "$repo/docs/DEPLOYMENT_CUTOVER.md" || \
  ! grep -Fq 'test "$FINAL_DLQ_IN_FLIGHT" = "0"' "$repo/docs/DEPLOYMENT_CUTOVER.md"; then
  echo "0017 final DLQ gate must require exactly zero visible and in-flight messages" >&2
  exit 1
fi

if grep -Fq -- '-le "$INITIAL_DLQ_' "$repo/docs/DEPLOYMENT_CUTOVER.md"; then
  echo "0017 DLQ gate must not accept a nonzero baseline" >&2
  exit 1
fi

if grep -Fq 'FENCE_AT="$(date ' "$repo/docs/DEPLOYMENT_CUTOVER.md"; then
  echo "0017 fence must come from PostgreSQL, never the operator host clock" >&2
  exit 1
fi

stage_line="$(grep -nF 'terraform apply 0017-definitions.tfplan' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
staged_assert_line="$(grep -nF 'assert_staged_task_definition "$STAGED_MIGRATION_TASK_JSON"' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
rollback_worker_disable_line="$(grep -nF 'ROLLBACK_DISABLE_WORKER_JSON=' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
rollback_api_disable_line="$(grep -nF 'ROLLBACK_DISABLE_API_JSON=' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
rollback_verified_line="$(grep -nF 'ROLLBACK_DISABLED_JSON=' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
fence_line="$(grep -nF 'inbound-provenance-fence' "$repo/docs/DEPLOYMENT_CUTOVER.md" | tail -1 | cut -d: -f1)"
worker_stop_line="$(grep -nF -- '--service "$WORKER_SERVICE" --desired-count 0' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
worker_zero_line="$(grep -nF 'WORKER_ZERO_JSON=' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
worker_tasks_zero_line="$(grep -nF 'test "$WORKER_ZERO_TASK_COUNT" = "0"' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
queue_stable_zero_line="$(grep -nF 'test "$QUEUE_IN_FLIGHT_STABLE_READS" -ge 3' "$repo/docs/DEPLOYMENT_CUTOVER.md" | tail -1 | cut -d: -f1)"
api_stop_line="$(grep -nF -- '--service "$API_SERVICE" --desired-count 0' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
services_zero_line="$(grep -nF 'SERVICE_ZERO_JSON=' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
worker_tasks_recheck_line="$(grep -nF 'test "$WORKER_ZERO_TASK_COUNT_AFTER_API" = "0"' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
api_tasks_zero_line="$(grep -nF 'test "$API_ZERO_TASK_COUNT" = "0"' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
for ordered_line in \
  "$stage_line" \
  "$staged_assert_line" \
  "$rollback_worker_disable_line" \
  "$rollback_api_disable_line" \
  "$rollback_verified_line" \
  "$worker_stop_line" \
  "$worker_zero_line" \
  "$worker_tasks_zero_line" \
  "$queue_stable_zero_line" \
  "$api_stop_line" \
  "$services_zero_line" \
  "$worker_tasks_recheck_line" \
  "$api_tasks_zero_line" \
  "$fence_line"; do
  test -n "$ordered_line" || {
    echo "0017 cutover is missing a machine-readable zero-writer gate" >&2
    exit 1
  }
done
test "$stage_line" -lt "$staged_assert_line" \
  && test "$staged_assert_line" -lt "$rollback_worker_disable_line" \
  && test "$rollback_worker_disable_line" -lt "$rollback_api_disable_line" \
  && test "$rollback_api_disable_line" -lt "$rollback_verified_line" \
  && test "$rollback_verified_line" -lt "$worker_stop_line" \
  && test "$worker_stop_line" -lt "$worker_zero_line" \
  && test "$worker_zero_line" -lt "$worker_tasks_zero_line" \
  && test "$worker_tasks_zero_line" -lt "$queue_stable_zero_line" \
  && test "$queue_stable_zero_line" -lt "$api_stop_line" \
  && test "$api_stop_line" -lt "$services_zero_line" \
  && test "$services_zero_line" -lt "$worker_tasks_recheck_line" \
  && test "$worker_tasks_recheck_line" -lt "$api_tasks_zero_line" \
  && test "$api_tasks_zero_line" -lt "$fence_line" || {
  echo "0017 cutover must stage the release, prove the worker/queue/API zero, then capture the DB fence" >&2
  exit 1
}

migration_task_line="$(grep -nF 'MIGRATION_TASK=' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
migration_exit_line="$(grep -nF 'test "$MIGRATION_EXIT" = "0"' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
status_task_line="$(grep -nF 'STATUS_TASK=' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
status_exit_line="$(grep -nF 'test "$STATUS_EXIT" = "0"' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
status_json_line="$(grep -nF 'STATUS_JSON=' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
status_gate_line="$(grep -nF 'index("0017_inbound_message_source_provenance") != null' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
worker_start_line="$(grep -nF -- '--desired-count "$ORIGINAL_WORKER_COUNT"' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
audit_exit_line="$(grep -nF 'test "$AUDIT_EXIT" = "0"' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
api_start_line="$(grep -nF -- '--desired-count "$ORIGINAL_API_COUNT"' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
version_json_line="$(grep -nF 'VERSION_JSON=' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
version_gate_line="$(grep -nF '.version == $release_version' "$repo/docs/DEPLOYMENT_CUTOVER.md" | tail -1 | cut -d: -f1)"
reconcile_plan_line="$(grep -nF 'rehearsal_terraform plan' "$repo/docs/DEPLOYMENT_CUTOVER.md" | tail -1 | cut -d: -f1)"
for ordered_line in \
  "$migration_task_line" \
  "$migration_exit_line" \
  "$status_task_line" \
  "$status_exit_line" \
  "$status_json_line" \
  "$status_gate_line" \
  "$worker_start_line" \
  "$audit_exit_line" \
  "$api_start_line" \
  "$version_json_line" \
  "$version_gate_line" \
  "$reconcile_plan_line"; do
  test -n "$ordered_line" || {
    echo "0017 cutover is missing a migration, status, worker, audit, or API gate" >&2
    exit 1
  }
done
test "$fence_line" -lt "$migration_task_line" \
  && test "$migration_task_line" -lt "$migration_exit_line" \
  && test "$migration_exit_line" -lt "$status_task_line" \
  && test "$status_task_line" -lt "$status_exit_line" \
  && test "$status_exit_line" -lt "$status_json_line" \
  && test "$status_json_line" -lt "$status_gate_line" \
  && test "$status_gate_line" -lt "$worker_start_line" \
  && test "$worker_start_line" -lt "$audit_exit_line" \
  && test "$audit_exit_line" -lt "$api_start_line" \
  && test "$api_start_line" -lt "$version_json_line" \
  && test "$version_json_line" -lt "$version_gate_line" \
  && test "$version_gate_line" -lt "$reconcile_plan_line" || {
  echo "0017 cutover must run migration, status, release worker, audit, then API in order" >&2
  exit 1
}

for zero_assertion in \
  '(.services[0].desiredCount == 0)' \
  '(.services[0].runningCount == 0)' \
  'and .desiredCount == 0' \
  'and .runningCount == 0' \
  "--query 'length(taskArns)'" \
  'test "$CURRENT_QUEUE_IN_FLIGHT" = "0"'; do
  grep -Fq -- "$zero_assertion" "$repo/docs/DEPLOYMENT_CUTOVER.md" || {
    echo "0017 cutover missing machine assertion '$zero_assertion'" >&2
    exit 1
  }
done

for command_phrase in \
  "aws ecs run-task" \
  "aws ecs wait tasks-stopped" \
  "aws ecs describe-tasks" \
  "--desired-count 0" \
  "deploymentCircuitBreaker={enable=true,rollback=false}" \
  "deploymentConfiguration.deploymentCircuitBreaker.rollback" \
  "assert_staged_task_definition" \
  '(.taskDefinition.runtimePlatform.cpuArchitecture == "X86_64")' \
  '(.taskDefinition.containerDefinitions[0].image == $image_reference)' \
  '(.taskDefinition.taskRoleArn == $task_role)' \
  '(.taskDefinition.executionRoleArn == $execution_role)' \
  '--desired-count "$ORIGINAL_WORKER_COUNT"' \
  '--desired-count "$ORIGINAL_API_COUNT"' \
  "get-queue-attributes" \
  "inbound-provenance-audit" \
  '--arg since "$FENCE_AT"' \
  '"inbound-provenance-audit","--since",$since' \
  "schema_migrations" \
  "VERSION_JSON" \
  '(.version == $release_version)' \
  "/ready"; do
  grep -Fiq -- "$command_phrase" "$repo/docs/DEPLOYMENT_CUTOVER.md" || {
    echo "0017 cutover rehearsal missing '$command_phrase' from docs/DEPLOYMENT_CUTOVER.md" >&2
    exit 1
  }
done

if grep -Eiq 'keep (the )?(existing|old|pre-0017).*(task|worker|API).*(running|live).*(migration|replacement)|old task stays running' \
  "$repo/docs/DEPLOYMENT_CUTOVER.md"; then
  echo "0017 cutover must not overlap migration or replacement with incompatible tasks" >&2
  exit 1
fi

echo "static self-hosting contract: pass"
