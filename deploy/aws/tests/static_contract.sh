#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
repo=$(CDPATH= cd -- "$root/../.." && pwd)
cd "$root"

if rg -n -i \
  'hasna[.]xyz|mailery[.]co|MAILERY|HASNA_EMAILS|HASNA_MAILERY|API_KEY_SIGNING_SECRET' \
  . \
  --glob '!tests/**'; then
  echo "forbidden hosted-service coupling found" >&2
  exit 1
fi

if rg -n 'name[[:space:]]*=[[:space:]]*"DATABASE_URL"|\["mailery|\["mailery-serve' compute.tf; then
  echo "legacy command or generic secret environment found" >&2
  exit 1
fi

for sid in ReadInboundBucket ReadInboundObjects ConsumeInboundQueue DecryptInboundData; do
  if ! rg -U -q "dynamic \"statement\" \\{[[:space:]]*for_each = var[.]enable_ses_inbound[^}]*sid[[:space:]]*=[[:space:]]*\"$sid\"" iam.tf; then
    echo "worker permission $sid is not gated by enable_ses_inbound" >&2
    exit 1
  fi
done

if rg -n \
  'arn:aws:[a-z0-9-]+:[a-z0-9-]*:[0-9]{12}' \
  . \
  --glob '!tests/**' \
  --glob '!examples/**'; then
  echo "concrete AWS account ARN found outside test/example fixtures" >&2
  exit 1
fi

if rg -n 'resource[[:space:]]+"aws_ses_active_receipt_rule_set"' .; then
  echo "Terraform must not activate the account-global SES receipt rule set" >&2
  exit 1
fi

if rg -n 'resource[[:space:]]+"aws_secretsmanager_secret_version"' .; then
  echo "Terraform must not place secret values in state" >&2
  exit 1
fi

if rg -n '^[[:space:]]+(ingress|egress)[[:space:]]*\{' network.tf; then
  echo "inline security-group rules are forbidden; use standalone rule resources" >&2
  exit 1
fi

if rg -n 'http://' outputs.tf; then
  echo "client endpoint outputs must be HTTPS-only" >&2
  exit 1
fi

if rg -n '^check[[:space:]]+"' . --glob '*.tf'; then
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

rg -F -q '".github/workflows/**"' "$workflow" || {
  echo "workflow changes must trigger the static legacy-workflow guard" >&2
  exit 1
}

rg -F -q 'terraform providers lock -platform=darwin_arm64 -platform=linux_amd64' "$workflow" || {
  echo "Terraform CI must verify both development and hosted-runner provider checksums" >&2
  exit 1
}

if rg -n 'id-token:[[:space:]]*write|configure-aws-credentials|amazon-ecr-login|role-to-assume|aws configure' "$workflow_dir" --glob '*.y*ml'; then
  echo "workflows must not request AWS credentials or OIDC" >&2
  exit 1
fi

if rg -n '^[[:space:]]*(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)[[:space:]]*:' "$workflow_dir" --glob '*.y*ml'; then
  echo "workflows must not provide AWS credential environment values" >&2
  exit 1
fi

if rg -n '\b(terraform|tofu)[[:space:]]+(apply|destroy)\b|\b(npm|bun|pnpm|yarn)[[:space:]]+publish\b|ecs[[:space:]]+update-service' "$workflow_dir" --glob '*.y*ml'; then
  echo "workflows must not apply, destroy, publish, or deploy" >&2
  exit 1
fi

for allowed_workflow in "$workflow" "$product_workflow"; do
  uses_count="$(rg -c 'uses:' "$allowed_workflow")"
  pinned_uses_count="$(rg -c 'uses:[[:space:]]+[^@[:space:]]+@[0-9a-f]{40}([[:space:]]+#.*)?$' "$allowed_workflow")"
  if [ "$uses_count" != "$pinned_uses_count" ]; then
    echo "every workflow action must be pinned to an immutable commit SHA" >&2
    exit 1
  fi
done

echo "static self-hosting contract: pass"
