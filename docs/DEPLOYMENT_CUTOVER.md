# Deployment cutover

This repository intentionally has no automatic deployment workflow. Merging or
tagging the repository cannot publish a package, push an image, or update AWS.

Before a future `workflow_dispatch` deployment is introduced, an operator must
provide an Emails-owned infrastructure manifest and least-privilege role in the
target user's AWS account. The workflow must use `APP=emails`, require an
explicit environment approval, and must not contain a Hasna account ID, bucket,
cluster, database URL, secret path, or default endpoint.

Rename cutover is additive: released Mailery migration ids/checksums and the
old API key remain valid during the rollback window. Apply the Emails bridge,
mint a new key with `emails self-hosted key rotate`, move and verify clients,
then revoke the old key explicitly. Do not delete or rewrite historical
migration-ledger rows.

## Tenant-sealing migration gate (0016)

Before migration 0016, discover and inventory every old API, worker, ingest,
backfill, scheduled, and one-off writer. Drain and stop all of them, then run a
new-code-compatible migrator through 0016 and verify the migration ledger before
starting any service. Start only tenant-aware new-code writers after the ledger
check passes.

For the AWS module, set `enable_automatic_deployment_rollback = false` before
draining writers and keep it false through 0016 and the first tenant-aware API
and worker activation. A failed activation must roll forward; ECS must not be
allowed to restore an unknown previous deployment. After both services complete
a tenant-aware deployment and pass verification, set
`enable_automatic_deployment_rollback = true` in a separate reviewed apply.
Terraform rejects enabling the gate before `migrations_complete`; setting it
true is the operator's explicit acknowledgement that the previous completed API
and worker deployment is tenant-aware and schema-compatible.

After 0016 commits, a pre-tenancy or otherwise unscoped image is not a valid
rollback target. Roll forward to a corrected tenant-aware image, or execute an
operator-reviewed explicit schema recovery plan while every writer remains
stopped.

## Attachment-provenance migration gate (0017 / 1.2.4)

Migration 0017 is a forward-only production cutover. Package/image 1.2.3 does
not recognize the new immutable provenance ledger entry and is not a valid
restart, scale-out, or rollback target after 0017 commits. This cutover requires
controlled downtime. The old worker and API are both at zero before the ledger
advances; SQS buffers new mail while no worker runs. Only the 1.2.4 worker is
started after migration, and its privacy-safe provenance audit must exit zero
before the API is started. Leave `enable_automatic_deployment_rollback = false`
through the observation window.

> **Production hard stop:** this generic Terraform rehearsal is **UNUSABLE for
> the actual live topology**. Never run, copy, or paste any command block below
> against the live environment. The known live cluster and service topology is
> not owned by this Terraform state, so its outputs, task-definition families,
> service resources, and reconciliation plan are not production authority.

Actual live execution requires a separately generated and independently reviewed
AWS CLI plan cloned from the exact live service task definitions. That plan must
preserve and review the live roles, container names, environment, secret
references, networking, logging, health checks, and stop timeouts while changing
only the approved immutable image and deliberately reviewed compatibility fields.
The generic Terraform reconciliation in this document remains unsafe until the
actual live resources have been imported or adopted into authoritative state and
an independently reviewed no-op plan proves complete ownership and zero drift.
This document is never a substitute for that production plan.

The commands below are only an evidence-producing isolated rehearsal template.
Run them from `deploy/aws` against a disposable, explicitly named rehearsal
topology with a reviewed backend and tfvars. `IMAGE_124` is the reviewed immutable
1.2.4 image digest, not a tag. Before the first Terraform plan, an operator must
provide a reviewed topology manifest and its separately reviewed SHA-256. The
preflight validates the manifest's exact schema, caller account and region,
Terraform outputs, current ECS service and task-definition identities, and the
queue/DLQ relationship. Any mismatch, AWS failure, or nonzero initial DLQ aborts.

### 1. Prove topology, stage 1.2.4, stop every old writer, then save a database fence

```bash
set -euo pipefail

: "${RUNBOOK_MODE:?set RUNBOOK_MODE=isolated-rehearsal only for a disposable rehearsal}"
: "${REHEARSAL_NAME:?set the explicit non-live Terraform name containing rehearsal}"
: "${REHEARSAL_ACCOUNT_ID:?set the reviewed rehearsal AWS account ID}"
: "${REHEARSAL_TOPOLOGY_MANIFEST:?set the path to the reviewed topology manifest}"
: "${REHEARSAL_TOPOLOGY_SHA256:?set the separately reviewed manifest SHA-256}"
: "${IMAGE_124:?set the reviewed immutable 1.2.4 image digest}"
: "${TFVARS:?set the reviewed rehearsal tfvars path}"
: "${AWS_REGION:?set the reviewed rehearsal AWS region}"

case "$REHEARSAL_TOPOLOGY_SHA256" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]\
[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]\
[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]\
[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]\
[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]\
[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]\
[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]\
[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) printf '%s\n' "invalid rehearsal topology SHA-256" >&2; exit 64 ;;
esac
ACTUAL_TOPOLOGY_SHA256="$(sha256sum -- "$REHEARSAL_TOPOLOGY_MANIFEST" | awk '{print $1}')"
test "$ACTUAL_TOPOLOGY_SHA256" = "$REHEARSAL_TOPOLOGY_SHA256"

EXPECTED_TOPOLOGY_KEYS='["account_id","api_service","api_task_definition","cluster","dlq_arn","dlq_url","environment","live","migration_task_definition","private_subnet_ids","purpose","queue_arn","queue_url","region","schema_version","task_security_group_id","worker_service","worker_task_definition"]'
TOPOLOGY_JSON="$(jq -ceS --argjson expected_keys "$EXPECTED_TOPOLOGY_KEYS" '
  select(type == "object")
  | select((keys | sort) == $expected_keys)
  | select(.schema_version == 1 and .purpose == "isolated-rehearsal")
  | select(.environment == "rehearsal" and .live == false)
  | select(.account_id | type == "string" and test("^[0-9]{12}$"))
  | select(.region | type == "string" and test("^[a-z]{2}(-[a-z]+)+-[0-9]+$"))
  | select(all([
      .cluster, .api_service, .worker_service,
      .api_task_definition, .worker_task_definition, .migration_task_definition,
      .queue_url, .queue_arn, .dlq_url, .dlq_arn, .task_security_group_id
    ][]; type == "string" and length > 0))
  | select(.private_subnet_ids | type == "array" and length > 0)
  | select(.private_subnet_ids | all(.[]; type == "string" and startswith("subnet-")))
  | select(.private_subnet_ids | (unique | length) == length)
' "$REHEARSAL_TOPOLOGY_MANIFEST")"

MANIFEST_ACCOUNT_ID="$(jq -r '.account_id' <<<"$TOPOLOGY_JSON")"
MANIFEST_REGION="$(jq -r '.region' <<<"$TOPOLOGY_JSON")"
MANIFEST_ENVIRONMENT="$(jq -r '.environment' <<<"$TOPOLOGY_JSON")"
MANIFEST_LIVE="$(jq -r '.live' <<<"$TOPOLOGY_JSON")"
MANIFEST_CLUSTER="$(jq -r '.cluster' <<<"$TOPOLOGY_JSON")"
MANIFEST_API_SERVICE="$(jq -r '.api_service' <<<"$TOPOLOGY_JSON")"
MANIFEST_WORKER_SERVICE="$(jq -r '.worker_service' <<<"$TOPOLOGY_JSON")"
MANIFEST_API_TASK_DEFINITION="$(jq -r '.api_task_definition' <<<"$TOPOLOGY_JSON")"
MANIFEST_WORKER_TASK_DEFINITION="$(jq -r '.worker_task_definition' <<<"$TOPOLOGY_JSON")"
MANIFEST_MIGRATION_TASK_DEFINITION="$(jq -r '.migration_task_definition' <<<"$TOPOLOGY_JSON")"
MANIFEST_QUEUE_URL="$(jq -r '.queue_url' <<<"$TOPOLOGY_JSON")"
MANIFEST_QUEUE_ARN="$(jq -r '.queue_arn' <<<"$TOPOLOGY_JSON")"
MANIFEST_DLQ_URL="$(jq -r '.dlq_url' <<<"$TOPOLOGY_JSON")"
MANIFEST_DLQ_ARN="$(jq -r '.dlq_arn' <<<"$TOPOLOGY_JSON")"
MANIFEST_SUBNETS="$(jq -cS '.private_subnet_ids | sort' <<<"$TOPOLOGY_JSON")"
MANIFEST_TASK_SG="$(jq -r '.task_security_group_id' <<<"$TOPOLOGY_JSON")"

test -n "$IMAGE_124"
test -n "$TFVARS"
test -n "$AWS_REGION"

CLUSTER="$(terraform output -raw ecs_cluster_name)"
API_SERVICE="$(terraform output -raw api_service_name)"
WORKER_SERVICE="$(terraform output -raw worker_service_name)"
QUEUE_URL="$(terraform output -raw inbound_queue_url)"
DLQ_URL="$(terraform output -raw inbound_dlq_url)"
SUBNETS="$(terraform output -json private_subnet_ids | jq -r 'join(",")')"
TASK_SG="$(terraform output -raw ecs_task_security_group_id)"
NETWORK="awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$TASK_SG],assignPublicIp=DISABLED}"
INITIAL_API_DEF="$(terraform output -raw api_task_definition_arn)"
INITIAL_WORKER_DEF="$(terraform output -raw worker_task_definition_arn)"
INITIAL_MIGRATION_DEF="$(terraform output -raw migration_task_definition_arn)"
TF_ACCOUNT_ID="$(terraform output -raw operator_account_id)"
TF_SUBNETS="$(terraform output -json private_subnet_ids | jq -cS 'sort')"

require_isolated_rehearsal() {
  if test "$RUNBOOK_MODE" != "isolated-rehearsal"; then
    printf '%s\n' "hard stop: RUNBOOK_MODE is not isolated-rehearsal" >&2
    return 64
  fi
  case "$REHEARSAL_NAME" in
    *rehearsal*) ;;
    *) printf '%s\n' "hard stop: REHEARSAL_NAME must contain rehearsal" >&2; return 64 ;;
  esac
  if test "$REHEARSAL_NAME" != "$MANIFEST_CLUSTER" ||
    test "$CLUSTER" != "$REHEARSAL_NAME" ||
    test "$API_SERVICE" != "${REHEARSAL_NAME}-api" ||
    test "$WORKER_SERVICE" != "${REHEARSAL_NAME}-worker"; then
    printf '%s\n' "hard stop: topology is not the exact generic rehearsal topology" >&2
    return 64
  fi
  if test "$MANIFEST_ENVIRONMENT" != "rehearsal" || test "$MANIFEST_LIVE" != "false"; then
    printf '%s\n' "hard stop: manifest is not sealed as a non-live rehearsal" >&2
    return 64
  fi
  if test "$REHEARSAL_ACCOUNT_ID" != "$MANIFEST_ACCOUNT_ID" ||
    test "$TF_ACCOUNT_ID" != "$MANIFEST_ACCOUNT_ID"; then
    printf '%s\n' "hard stop: rehearsal account identity mismatch" >&2
    return 64
  fi
}

rehearsal_terraform() {
  require_isolated_rehearsal
  command terraform "$@"
}

rehearsal_aws() {
  require_isolated_rehearsal
  command aws "$@"
}

require_isolated_rehearsal
test "$AWS_REGION" = "$MANIFEST_REGION"
test "$(aws sts get-caller-identity --query Account --output text)" = "$MANIFEST_ACCOUNT_ID"
test "$API_SERVICE" = "$MANIFEST_API_SERVICE"
test "$WORKER_SERVICE" = "$MANIFEST_WORKER_SERVICE"
test "$INITIAL_API_DEF" = "$MANIFEST_API_TASK_DEFINITION"
test "$INITIAL_WORKER_DEF" = "$MANIFEST_WORKER_TASK_DEFINITION"
test "$INITIAL_MIGRATION_DEF" = "$MANIFEST_MIGRATION_TASK_DEFINITION"
test "$QUEUE_URL" = "$MANIFEST_QUEUE_URL"
test "$DLQ_URL" = "$MANIFEST_DLQ_URL"
test "$TF_SUBNETS" = "$MANIFEST_SUBNETS"
test "$TASK_SG" = "$MANIFEST_TASK_SG"

SERVICE_PREFLIGHT_JSON="$(aws ecs describe-services --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$WORKER_SERVICE" "$API_SERVICE" --output json)"
jq -e --arg api_service "$MANIFEST_API_SERVICE" \
  --arg worker_service "$MANIFEST_WORKER_SERVICE" \
  --arg api_definition "$MANIFEST_API_TASK_DEFINITION" \
  --arg worker_definition "$MANIFEST_WORKER_TASK_DEFINITION" '
  (.failures | length) == 0
  and (.services | length) == 2
  and any(.services[]; .serviceName == $api_service and .taskDefinition == $api_definition)
  and any(.services[]; .serviceName == $worker_service and .taskDefinition == $worker_definition)
' <<<"$SERVICE_PREFLIGHT_JSON" >/dev/null

API_TASK_PREFLIGHT_JSON="$(aws ecs describe-task-definition --region "$AWS_REGION" \
  --task-definition "$MANIFEST_API_TASK_DEFINITION" --output json)"
WORKER_TASK_PREFLIGHT_JSON="$(aws ecs describe-task-definition --region "$AWS_REGION" \
  --task-definition "$MANIFEST_WORKER_TASK_DEFINITION" --output json)"
MIGRATION_TASK_PREFLIGHT_JSON="$(aws ecs describe-task-definition --region "$AWS_REGION" \
  --task-definition "$MANIFEST_MIGRATION_TASK_DEFINITION" --output json)"
jq -e --arg expected "$MANIFEST_API_TASK_DEFINITION" \
  '.taskDefinition.taskDefinitionArn == $expected' <<<"$API_TASK_PREFLIGHT_JSON" >/dev/null
jq -e --arg expected "$MANIFEST_WORKER_TASK_DEFINITION" \
  '.taskDefinition.taskDefinitionArn == $expected' <<<"$WORKER_TASK_PREFLIGHT_JSON" >/dev/null
jq -e --arg expected "$MANIFEST_MIGRATION_TASK_DEFINITION" \
  '.taskDefinition.taskDefinitionArn == $expected' <<<"$MIGRATION_TASK_PREFLIGHT_JSON" >/dev/null

INITIAL_QUEUE_COUNTS="$(aws sqs get-queue-attributes --region "$AWS_REGION" --queue-url "$QUEUE_URL" \
  --attribute-names QueueArn RedrivePolicy ApproximateNumberOfMessages \
    ApproximateNumberOfMessagesNotVisible VisibilityTimeout --output json)"
INITIAL_DLQ_COUNTS="$(aws sqs get-queue-attributes --region "$AWS_REGION" --queue-url "$DLQ_URL" \
  --attribute-names QueueArn ApproximateNumberOfMessages \
    ApproximateNumberOfMessagesNotVisible --output json)"
QUEUE_ARN="$(jq -er '.Attributes.QueueArn' <<<"$INITIAL_QUEUE_COUNTS")"
DLQ_ARN="$(jq -er '.Attributes.QueueArn' <<<"$INITIAL_DLQ_COUNTS")"
test "$QUEUE_ARN" = "$MANIFEST_QUEUE_ARN"
test "$DLQ_ARN" = "$MANIFEST_DLQ_ARN"
jq -e --arg dlq_arn "$DLQ_ARN" \
  '.Attributes.RedrivePolicy | fromjson | .deadLetterTargetArn == $dlq_arn' \
  <<<"$INITIAL_QUEUE_COUNTS" >/dev/null
INITIAL_DLQ_VISIBLE="$(jq -er '.Attributes.ApproximateNumberOfMessages | tonumber' <<<"$INITIAL_DLQ_COUNTS")"
INITIAL_DLQ_IN_FLIGHT="$(jq -er '.Attributes.ApproximateNumberOfMessagesNotVisible | tonumber' <<<"$INITIAL_DLQ_COUNTS")"
test "$INITIAL_DLQ_VISIBLE" = "0"
test "$INITIAL_DLQ_IN_FLIGHT" = "0"
printf '%s\n' "$INITIAL_QUEUE_COUNTS" "$INITIAL_DLQ_COUNTS"

ORIGINAL_WORKER_COUNT="$(aws ecs describe-services --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$WORKER_SERVICE" --query 'services[0].desiredCount' --output text)"
ORIGINAL_API_COUNT="$(aws ecs describe-services --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$API_SERVICE" --query 'services[0].desiredCount' --output text)"
WORKER_MIN="$(aws ecs describe-services --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$WORKER_SERVICE" --query 'services[0].deploymentConfiguration.minimumHealthyPercent' --output text)"
WORKER_MAX="$(aws ecs describe-services --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$WORKER_SERVICE" --query 'services[0].deploymentConfiguration.maximumPercent' --output text)"
API_MIN="$(aws ecs describe-services --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$API_SERVICE" --query 'services[0].deploymentConfiguration.minimumHealthyPercent' --output text)"
API_MAX="$(aws ecs describe-services --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$API_SERVICE" --query 'services[0].deploymentConfiguration.maximumPercent' --output text)"
test "$ORIGINAL_WORKER_COUNT" -gt 0
test "$ORIGINAL_API_COUNT" -gt 0

aws ecs describe-services --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$WORKER_SERVICE" "$API_SERVICE" \
  --query 'services[].{service:serviceName,desired:desiredCount,running:runningCount,taskDefinition:taskDefinition,deployments:deployments}'

# Register only reviewed 1.2.4 definitions. Neither service may be updated by
# this targeted plan, and all desired counts remain unchanged at this point.
rehearsal_terraform plan -var-file="$TFVARS" -var="container_image=$IMAGE_124" \
  -var="enable_automatic_deployment_rollback=false" \
  -target=aws_ecs_task_definition.migration \
  -target=aws_ecs_task_definition.worker \
  -target=aws_ecs_task_definition.api \
  -out=0017-definitions.tfplan
terraform show 0017-definitions.tfplan
rehearsal_terraform apply 0017-definitions.tfplan

MIGRATION_DEF="$(terraform output -raw migration_task_definition_arn)"
WORKER_DEF="$(terraform output -raw worker_task_definition_arn)"
API_DEF="$(terraform output -raw api_task_definition_arn)"

rehearsal_aws ecs update-service --region "$AWS_REGION" --cluster "$CLUSTER" \
  --service "$WORKER_SERVICE" --desired-count 0 \
  --deployment-configuration "deploymentCircuitBreaker={enable=true,rollback=false},minimumHealthyPercent=$WORKER_MIN,maximumPercent=$WORKER_MAX"
aws ecs wait services-stable --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$WORKER_SERVICE"

WORKER_ZERO_JSON="$(aws ecs describe-services --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$WORKER_SERVICE" --output json)"
jq -e --arg service "$WORKER_SERVICE" '
  (.failures | length) == 0
  and (.services | length) == 1
  and (.services[0].serviceName == $service)
  and (.services[0].desiredCount == 0)
  and (.services[0].runningCount == 0)
  and (.services[0].deploymentConfiguration.deploymentCircuitBreaker.rollback == false)
' <<<"$WORKER_ZERO_JSON" >/dev/null
WORKER_ZERO_TASK_COUNT="$(aws ecs list-tasks --region "$AWS_REGION" --cluster "$CLUSTER" \
  --service-name "$WORKER_SERVICE" --query 'length(taskArns)' --output text)"
test "$WORKER_ZERO_TASK_COUNT" = "0"

# SQS counts are approximate. Require three consecutive bounded reads with no
# in-flight message before stopping the API or accepting the worker as drained.
QUEUE_IN_FLIGHT_STABLE_READS=0
for attempt in $(seq 1 12); do
  CURRENT_QUEUE_IN_FLIGHT="$(aws sqs get-queue-attributes --region "$AWS_REGION" --queue-url "$QUEUE_URL" \
    --attribute-names ApproximateNumberOfMessagesNotVisible \
    --query 'Attributes.ApproximateNumberOfMessagesNotVisible' --output text)"
  if test "$CURRENT_QUEUE_IN_FLIGHT" = "0"; then
    QUEUE_IN_FLIGHT_STABLE_READS=$((QUEUE_IN_FLIGHT_STABLE_READS + 1))
  else
    QUEUE_IN_FLIGHT_STABLE_READS=0
  fi
  test "$QUEUE_IN_FLIGHT_STABLE_READS" -ge 3 && break
  test "$attempt" -lt 12 || exit 1
  sleep 5
done
test "$QUEUE_IN_FLIGHT_STABLE_READS" -ge 3

rehearsal_aws ecs update-service --region "$AWS_REGION" --cluster "$CLUSTER" \
  --service "$API_SERVICE" --desired-count 0 \
  --deployment-configuration "deploymentCircuitBreaker={enable=true,rollback=false},minimumHealthyPercent=$API_MIN,maximumPercent=$API_MAX"
aws ecs wait services-stable --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$API_SERVICE"

SERVICE_ZERO_JSON="$(aws ecs describe-services --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$WORKER_SERVICE" "$API_SERVICE" --output json)"
jq -e --arg worker "$WORKER_SERVICE" --arg api "$API_SERVICE" '
  (.failures | length) == 0
  and (.services | length) == 2
  and all(.services[];
    (.serviceName == $worker or .serviceName == $api)
    and .desiredCount == 0
    and .runningCount == 0
    and .deploymentConfiguration.deploymentCircuitBreaker.rollback == false)
' <<<"$SERVICE_ZERO_JSON" >/dev/null
WORKER_ZERO_TASK_COUNT_AFTER_API="$(aws ecs list-tasks --region "$AWS_REGION" --cluster "$CLUSTER" \
  --service-name "$WORKER_SERVICE" --query 'length(taskArns)' --output text)"
API_ZERO_TASK_COUNT="$(aws ecs list-tasks --region "$AWS_REGION" --cluster "$CLUSTER" \
  --service-name "$API_SERVICE" --query 'length(taskArns)' --output text)"
test "$WORKER_ZERO_TASK_COUNT_AFTER_API" = "0"
test "$API_ZERO_TASK_COUNT" = "0"

# Capture the PostgreSQL wall-clock cutoff only after machine-readable service,
# task-list, and queue checks prove every old writer is gone. PostgreSQL fixes a
# row's created_at default at transaction start, so a pre-fence old transaction
# could otherwise commit after the cutoff while remaining outside the audit.
# This exact 1.2.4 one-shot does not query migration 0017 tables and is safe
# before the ledger advances.
FENCE_OVERRIDES='{"containerOverrides":[{"name":"worker","command":["bun","src/server/index.ts","inbound-provenance-fence"]}]}'
FENCE_TASK="$(rehearsal_aws ecs run-task --region "$AWS_REGION" --cluster "$CLUSTER" \
  --launch-type FARGATE --task-definition "$WORKER_DEF" \
  --network-configuration "$NETWORK" --count 1 --overrides "$FENCE_OVERRIDES" \
  --query 'tasks[0].taskArn' --output text)"
aws ecs wait tasks-stopped --region "$AWS_REGION" --cluster "$CLUSTER" --tasks "$FENCE_TASK"
FENCE_EXIT="$(aws ecs describe-tasks --region "$AWS_REGION" --cluster "$CLUSTER" --tasks "$FENCE_TASK" \
  --query 'tasks[0].containers[?name==`worker`].exitCode | [0]' --output text)"
test "$FENCE_EXIT" = "0"
FENCE_TASK_ID="${FENCE_TASK##*/}"
FENCE_JSON=""
for attempt in $(seq 1 12); do
  FENCE_LOG_EVENTS="$(aws logs get-log-events --region "$AWS_REGION" \
    --log-group-name "/ecs/${CLUSTER}/worker" --log-stream-name "worker/worker/${FENCE_TASK_ID}" \
    --start-from-head --output json)"
  FENCE_JSON="$(jq -cer '[.events[].message | fromjson? | select((keys | sort) == ["fence_at"])]
    | select(length == 1) | .[0]' <<<"$FENCE_LOG_EVENTS" 2>/dev/null || true)"
  test -n "$FENCE_JSON" && break
  test "$attempt" -lt 12 || exit 1
  sleep 5
done
FENCE_AT="$(jq -er '.fence_at | select(test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$"))' <<<"$FENCE_JSON")"
printf '%s\n' "$FENCE_JSON"
```

The worker must first show desired/running zero, an empty service task list, and
three consecutive zero in-flight SQS reads. Only then may the API stop. Both
services must subsequently pass the same machine-readable desired/running-zero
and empty-task-list checks before the 1.2.4 one-shot captures `FENCE_AT`. Record
the service JSON, task counts, queue/DLQ counts, and PostgreSQL-derived cutoff.

### 2. Migrate and verify ledger 0017

The three reviewed 1.2.4 definitions are already staged, every old task is
machine-proven absent, the stable queue in-flight gate passed, and only then was
the database-clock fence recorded. Automatic rollback stays disabled.

```bash
set -euo pipefail

MIGRATION_TASK="$(rehearsal_aws ecs run-task --region "$AWS_REGION" --cluster "$CLUSTER" \
  --launch-type FARGATE --task-definition "$MIGRATION_DEF" \
  --network-configuration "$NETWORK" --count 1 \
  --query 'tasks[0].taskArn' --output text)"
aws ecs wait tasks-stopped --region "$AWS_REGION" --cluster "$CLUSTER" --tasks "$MIGRATION_TASK"
MIGRATION_EXIT="$(aws ecs describe-tasks --region "$AWS_REGION" --cluster "$CLUSTER" --tasks "$MIGRATION_TASK" \
  --query 'tasks[0].containers[?name==`migration`].exitCode | [0]' --output text)"
test "$MIGRATION_EXIT" = "0"

STATUS_TASK="$(rehearsal_aws ecs run-task --region "$AWS_REGION" --cluster "$CLUSTER" \
  --launch-type FARGATE --task-definition "$MIGRATION_DEF" \
  --network-configuration "$NETWORK" --count 1 \
  --overrides '{"containerOverrides":[{"name":"migration","command":["bun","src/cli/index.tsx","--json","db","status"]}]}' \
  --query 'tasks[0].taskArn' --output text)"
aws ecs wait tasks-stopped --region "$AWS_REGION" --cluster "$CLUSTER" --tasks "$STATUS_TASK"
STATUS_EXIT="$(aws ecs describe-tasks --region "$AWS_REGION" --cluster "$CLUSTER" --tasks "$STATUS_TASK" \
  --query 'tasks[0].containers[?name==`migration`].exitCode | [0]' --output text)"
test "$STATUS_EXIT" = "0"
aws logs tail "/ecs/${CLUSTER}/migration" --region "$AWS_REGION" --since 15m
```

Both tasks must exit zero. The status JSON must show `pending: []`, valid
`schema_migrations` checksums, and
`0017_inbound_message_source_provenance` in `alreadyApplied`. Do not restart or
scale any 1.2.3 task after this point.

### 3. Start only the 1.2.4 worker, drain the buffer, and audit

The worker service starts from zero with the exact reviewed `WORKER_DEF`, so an
old and new worker never overlap. The API remains at zero.

```bash
set -euo pipefail

rehearsal_aws ecs update-service --region "$AWS_REGION" --cluster "$CLUSTER" \
  --service "$WORKER_SERVICE" --task-definition "$WORKER_DEF" \
  --desired-count "$ORIGINAL_WORKER_COUNT"
aws ecs wait services-stable --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$WORKER_SERVICE"
aws ecs describe-services --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$WORKER_SERVICE" \
  --query 'services[0].{desired:desiredCount,running:runningCount,taskDefinition:taskDefinition,deployments:deployments}'

for attempt in $(seq 1 80); do
  QUEUE_COUNTS="$(aws sqs get-queue-attributes --region "$AWS_REGION" --queue-url "$QUEUE_URL" \
    --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible --output json)"
  VISIBLE="$(jq -r '.Attributes.ApproximateNumberOfMessages' <<<"$QUEUE_COUNTS")"
  IN_FLIGHT="$(jq -r '.Attributes.ApproximateNumberOfMessagesNotVisible' <<<"$QUEUE_COUNTS")"
  test "$VISIBLE" = "0" && test "$IN_FLIGHT" = "0" && break
  test "$attempt" -lt 80 || exit 1
  sleep 15
done

AUDIT_OVERRIDES="$(jq -cn --arg since "$FENCE_AT" \
  '{containerOverrides:[{name:"worker",command:["bun","src/server/index.ts","inbound-provenance-audit","--since",$since]}]}')"
AUDIT_TASK="$(rehearsal_aws ecs run-task --region "$AWS_REGION" --cluster "$CLUSTER" \
  --launch-type FARGATE --task-definition "$WORKER_DEF" \
  --network-configuration "$NETWORK" --count 1 --overrides "$AUDIT_OVERRIDES" \
  --query 'tasks[0].taskArn' --output text)"
aws ecs wait tasks-stopped --region "$AWS_REGION" --cluster "$CLUSTER" --tasks "$AUDIT_TASK"
AUDIT_EXIT="$(aws ecs describe-tasks --region "$AWS_REGION" --cluster "$CLUSTER" --tasks "$AUDIT_TASK" \
  --query 'tasks[0].containers[?name==`worker`].exitCode | [0]' --output text)"
test "$AUDIT_EXIT" = "0"
aws logs tail "/ecs/${CLUSTER}/worker" --region "$AWS_REGION" --since 15m

# SQS metrics are approximate, so require three identical bounded final reads.
# Both DLQ dimensions must remain exactly zero; any DLQ item is a no-go.
DLQ_STABLE_READS=0
LAST_DLQ_COUNTS=""
for attempt in $(seq 1 12); do
  CURRENT_DLQ_COUNTS="$(aws sqs get-queue-attributes --region "$AWS_REGION" --queue-url "$DLQ_URL" \
    --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible --output json)"
  FINAL_DLQ_VISIBLE="$(jq -er '.Attributes.ApproximateNumberOfMessages | tonumber' <<<"$CURRENT_DLQ_COUNTS")"
  FINAL_DLQ_IN_FLIGHT="$(jq -er '.Attributes.ApproximateNumberOfMessagesNotVisible | tonumber' <<<"$CURRENT_DLQ_COUNTS")"
  CURRENT_DLQ_PAIR="${FINAL_DLQ_VISIBLE}:${FINAL_DLQ_IN_FLIGHT}"
  if test "$CURRENT_DLQ_PAIR" = "$LAST_DLQ_COUNTS"; then
    DLQ_STABLE_READS=$((DLQ_STABLE_READS + 1))
  else
    DLQ_STABLE_READS=1
    LAST_DLQ_COUNTS="$CURRENT_DLQ_PAIR"
  fi
  test "$DLQ_STABLE_READS" -ge 3 && break
  test "$attempt" -lt 12 || exit 1
  sleep 5
done
test "$DLQ_STABLE_READS" -ge 3
test "$FINAL_DLQ_VISIBLE" = "0"
test "$FINAL_DLQ_IN_FLIGHT" = "0"
printf '%s\n' "$CURRENT_DLQ_COUNTS"
```

Run `inbound-provenance-audit` from the exact worker definition, not the
migration definition: only the worker carries the deployment-owned canonical
S3 bucket setting. The command performs read-only all-tenant queries under RLS,
prints aggregate counts only, and exits nonzero for a missing or invalid binding.
Any nonzero exit, nonzero DLQ count, worker error, wrong task definition, or unresolved
cutoff-window row is a no-go: keep the API at zero, reconcile the affected raw
objects only through reviewed 1.2.4 canonical S3 replay, and rerun the audit.
Never patch message or provenance rows manually.

### 4. Start the 1.2.4 API and reconcile Terraform

```bash
set -euo pipefail

rehearsal_aws ecs update-service --region "$AWS_REGION" --cluster "$CLUSTER" \
  --service "$API_SERVICE" --task-definition "$API_DEF" \
  --desired-count "$ORIGINAL_API_COUNT"
aws ecs wait services-stable --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$API_SERVICE"
aws ecs describe-services --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$API_SERVICE" \
  --query 'services[0].{desired:desiredCount,running:runningCount,taskDefinition:taskDefinition,deployments:deployments}'
curl --fail --silent --show-error "$EMAILS_API_URL/version"
curl --fail --silent --show-error "$EMAILS_API_URL/ready"

rehearsal_terraform plan -var-file="$TFVARS" -var="container_image=$IMAGE_124" \
  -var="worker_desired_count=$ORIGINAL_WORKER_COUNT" \
  -var="api_desired_count=$ORIGINAL_API_COUNT" \
  -var="enable_automatic_deployment_rollback=false" -out=0017-reconcile.tfplan
terraform show 0017-reconcile.tfplan
rehearsal_terraform apply 0017-reconcile.tfplan
```

The final un-targeted plan must contain no unexpected service, queue, schema, or
network change. Record the image digest, all task ARNs/definitions and exit
codes, queue/DLQ snapshots, `FENCE_AT`, aggregate audit JSON, `/version`,
`/ready`, and CloudWatch locations.

Rollback after ledger 0017 is always a compatible roll-forward. A failed API
activation leaves the API at zero while the reviewed 1.2.4 worker continues to
protect the queue, or both services may be returned to zero for investigation.
Use only a corrected 1.2.4-or-newer image that recognizes 0017, repeat the
definition, ledger, worker, audit, and API gates, and reconcile Terraform. The
rollback image is never 1.2.3. Never remove or rewrite the 0017 ledger row.
