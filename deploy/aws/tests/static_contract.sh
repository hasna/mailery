#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
repo=$(CDPATH= cd -- "$root/../.." && pwd)
cd "$root"

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
for phrase in \
  "migration 0017" \
  "1.2.4" \
  "controlled downtime" \
  "old worker and API are both at zero" \
  "SQS buffers" \
  "FENCE_AT" \
  "inbound-provenance-fence" \
  "INITIAL_DLQ_VISIBLE" \
  "INITIAL_DLQ_IN_FLIGHT" \
  "DLQ_STABLE_READS" \
  "FENCE_LOG_EVENTS" \
  'select((keys | sort) == ["fence_at"])' \
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
  "only the 1.2.4 worker" \
  "before the API" \
  "compatible roll-forward" \
  "never 1.2.3"; do
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
service_preflight_line="$(grep -nF 'SERVICE_PREFLIGHT_JSON=' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
queue_identity_line="$(grep -nF 'deadLetterTargetArn == $dlq_arn' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
initial_dlq_zero_line="$(grep -nF 'test "$INITIAL_DLQ_VISIBLE" = "0"' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
first_plan_line="$(grep -nF 'rehearsal_terraform plan' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
first_mutation_line="$(grep -nE 'rehearsal_(terraform (plan|apply)|aws ecs (run-task|update-service))' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
for safety_line in \
  "$guard_line" \
  "$manifest_hash_line" \
  "$manifest_schema_line" \
  "$service_preflight_line" \
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
test "$stage_line" -lt "$worker_stop_line" \
  && test "$worker_stop_line" -lt "$worker_zero_line" \
  && test "$worker_zero_line" -lt "$worker_tasks_zero_line" \
  && test "$worker_tasks_zero_line" -lt "$queue_stable_zero_line" \
  && test "$queue_stable_zero_line" -lt "$api_stop_line" \
  && test "$api_stop_line" -lt "$services_zero_line" \
  && test "$services_zero_line" -lt "$worker_tasks_recheck_line" \
  && test "$worker_tasks_recheck_line" -lt "$api_tasks_zero_line" \
  && test "$api_tasks_zero_line" -lt "$fence_line" || {
  echo "0017 cutover must stage 1.2.4, prove the worker/queue/API zero, then capture the DB fence" >&2
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
  '--desired-count "$ORIGINAL_WORKER_COUNT"' \
  '--desired-count "$ORIGINAL_API_COUNT"' \
  "get-queue-attributes" \
  "inbound-provenance-audit" \
  '--arg since "$FENCE_AT"' \
  '"inbound-provenance-audit","--since",$since' \
  "schema_migrations" \
  "/ready"; do
  grep -Fiq -- "$command_phrase" "$repo/docs/DEPLOYMENT_CUTOVER.md" || {
    echo "0017 cutover rehearsal missing '$command_phrase' from docs/DEPLOYMENT_CUTOVER.md" >&2
    exit 1
  }
done

if grep -Fq "Keep the existing 1.2.3 tasks running" "$repo/docs/DEPLOYMENT_CUTOVER.md"; then
  echo "0017 cutover must not overlap migration with incompatible 1.2.3 tasks" >&2
  exit 1
fi

if grep -Fq "old task stays running until its 1.2.4 replacement is healthy" "$repo/docs/DEPLOYMENT_CUTOVER.md"; then
  echo "0017 cutover must not roll 1.2.4 over a live 1.2.3 worker" >&2
  exit 1
fi

echo "static self-hosting contract: pass"
