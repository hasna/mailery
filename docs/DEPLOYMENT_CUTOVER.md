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

## Attachment-provenance migration gate (0017)

Migration 0017 is a forward-only production cutover. A pre-0017 release does
not recognize the new immutable provenance ledger entry and is not a valid
restart, scale-out, or rollback target after 0017 commits. This cutover requires
controlled downtime. The old worker and API are both at zero before the ledger
advances; SQS buffers new mail while no worker runs. Only the release worker is
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

### Live plan input contract (non-executable)

The separate live AWS CLI plan must fail closed unless an independently reviewed
`LIVE_TOPOLOGY_MANIFEST` and its `LIVE_TOPOLOGY_SHA256` seal all of the inputs
below. These are operator-supplied values, not defaults or public resource
identifiers:

- `LIVE_API_TASK_FAMILY`, `LIVE_WORKER_TASK_FAMILY`, and
  `LIVE_MIGRATION_TASK_FAMILY` must identify the exact revisioned live task
  definition families cloned for this cutover. The plan must also pin the exact
  service names, container names, roles, secret references, queue, DLQ, bucket,
  prefix, subnets, security groups, log groups, and database identity from the
  live definitions.
- `LIVE_RUNTIME_ARCHITECTURE` must equal `X86_64` for the reviewed live
  topology. The image and all three cloned definitions must agree; an ARM image
  or an implicit architecture is a hard failure.
- `RELEASE_VERSION`, `RELEASE_COMMIT`, `SOURCE_ARCHIVE_SHA256`,
  `LIVE_IMAGE_REPOSITORY`, `IMAGE_DIGEST`, and `LIVE_IMAGE_REFERENCE` must
  identify one release. `IMAGE_DIGEST` is only the bare `sha256:` value;
  `LIVE_IMAGE_REFERENCE` must equal `LIVE_IMAGE_REPOSITORY@IMAGE_DIGEST` and is
  the only value passed to task definitions. Recompute the deterministic archive
  SHA-256 from the exact commit, verify the package version at that commit, and
  verify the image's immutable registry digest and OCI revision/version metadata.
- `NO_SES_SMOKE_TASK_ROLE_ARN` must identify a reviewed smoke role that denies
  `ses:SendEmail` and `ses:SendRawEmail`. Read-only smoke must use this role;
  the normal task role is not acceptable merely because the operator promises
  not to send.

The reviewed live plan must enforce this order:

1. Verify the manifest hash, caller account and region, exact API/worker/migration
   families, roles and container identities, `X86_64`, deterministic archive
   hash, full image reference and OCI metadata, current service definitions,
   queue/DLQ relationship, and database-specific recovery artifact.
2. Disable automatic rollback on both live services before any forward-only
   migration or service stop. Preserve the previous definitions only as
   pre-migration anchors; they are not rollback targets after 0017.
3. Stop the worker first. Prove desired and running counts are zero, its task
   list is empty, and the exact queue has three consecutive zero in-flight
   reads. Require exact zero visible and in-flight messages on the exact DLQ.
4. Stop the API second and prove both services have zero desired/running tasks
   and empty task lists. Capture `FENCE_AT` from PostgreSQL only after this
   zero-writer proof.
5. Take or verify a database-specific snapshot, clone, or restore artifact for
   the Emails database. Whole-instance recovery is forbidden when the database
   service is shared. Run the release migration definition, require migration
   and status exits of zero, valid checksums, `pending: []`, and 0017 applied.
6. Start only the release worker, drain the exact queue to zero visible and
   in-flight messages, keep the exact DLQ at zero, and require
   `inbound-provenance-audit --since "$FENCE_AT"` to exit zero before the API.
7. Start and smoke the release API with the no-SES role. Verify `/version`,
   `/ready`, unauthenticated denial, authenticated tenant-scoped reads, and an
   approved attachment hash without logging message or attachment content.
8. Treat outbound sending and super-admin bootstrap as separate explicit approval
   actions. Neither belongs in migration, worker drain, read-only
   smoke, or API promotion. Bootstrap approval must name the one-time operator,
   key id, idempotency proof, wrong-key denial, and post-bootstrap revocation.

After 0017 begins, recovery is a compatible roll-forward or a database-specific
restore while every writer is stopped. A pre-0017 release is never a recovery
target, and automatic rollback remains disabled until a later reviewed change
makes a completed compatible deployment the rollback target.

The commands below are only an evidence-producing isolated rehearsal template.
Run them from `deploy/aws` against a disposable, explicitly named rehearsal
topology with a reviewed backend and tfvars. `IMAGE_DIGEST` is the reviewed bare
digest; `IMAGE_REFERENCE` is the full immutable
`IMAGE_REPOSITORY@IMAGE_DIGEST` value passed to Terraform. Before the first
Terraform plan, an operator must provide a reviewed topology manifest and its
separately reviewed SHA-256. The preflight validates the manifest's exact
schema, release inputs, source commit, registry metadata, caller account and
region, Terraform outputs, current ECS service and task-definition identities,
and the queue/DLQ relationship. Any mismatch, AWS failure, or nonzero initial
DLQ aborts.

### 1. Prove topology, stage the release, stop every old writer, then save a database fence

```bash
set -euo pipefail

: "${RUNBOOK_MODE:?set RUNBOOK_MODE=isolated-rehearsal only for a disposable rehearsal}"
: "${REHEARSAL_NAME:?set the explicit non-live Terraform name containing rehearsal}"
: "${REHEARSAL_ACCOUNT_ID:?set the reviewed rehearsal AWS account ID}"
: "${REHEARSAL_TOPOLOGY_MANIFEST:?set the path to the reviewed topology manifest}"
: "${REHEARSAL_TOPOLOGY_SHA256:?set the separately reviewed manifest SHA-256}"
: "${SOURCE_CHECKOUT:?set the exact local source checkout}"
: "${RELEASE_VERSION:?set the reviewed release version}"
: "${RELEASE_COMMIT:?set the reviewed release commit}"
: "${SOURCE_ARCHIVE_SHA256:?set the deterministic release archive SHA-256}"
: "${IMAGE_REPOSITORY:?set the immutable image repository without a tag or digest}"
: "${IMAGE_DIGEST:?set the reviewed bare sha256 release image digest}"
: "${IMAGE_REFERENCE:?set the full IMAGE_REPOSITORY@IMAGE_DIGEST reference}"
: "${IMAGE_SECURITY_REPORT:?set the exact-image Trivy JSON report path}"
: "${IMAGE_SECURITY_REPORT_SHA256:?set the reviewed Trivy report SHA-256}"
: "${IMAGE_SBOM:?set the exact-image CycloneDX SBOM path}"
: "${IMAGE_SBOM_SHA256:?set the reviewed CycloneDX SBOM SHA-256}"
: "${TFVARS:?set the reviewed rehearsal tfvars path}"
: "${AWS_REGION:?set the reviewed rehearsal AWS region}"

printf '%s' "$RELEASE_VERSION" | grep -Eq '^[0-9]+[.][0-9]+[.][0-9]+([+-][0-9A-Za-z.-]+)?$'
printf '%s' "$RELEASE_COMMIT" | grep -Eq '^[0-9a-f]{40}$'
printf '%s' "$SOURCE_ARCHIVE_SHA256" | grep -Eq '^[0-9a-f]{64}$'
printf '%s' "$IMAGE_REPOSITORY" | grep -Eq '^[^@[:space:]]+/[^@[:space:]]+$'
printf '%s' "$IMAGE_DIGEST" | grep -Eq '^sha256:[0-9a-f]{64}$'
test "$IMAGE_REFERENCE" = "${IMAGE_REPOSITORY}@${IMAGE_DIGEST}"
printf '%s' "$IMAGE_SECURITY_REPORT_SHA256" | grep -Eq '^[0-9a-f]{64}$'
printf '%s' "$IMAGE_SBOM_SHA256" | grep -Eq '^[0-9a-f]{64}$'
test -s "$IMAGE_SECURITY_REPORT"
test -s "$IMAGE_SBOM"
test "$(sha256sum "$IMAGE_SECURITY_REPORT" | awk '{print $1}')" = "$IMAGE_SECURITY_REPORT_SHA256"
test "$(sha256sum "$IMAGE_SBOM" | awk '{print $1}')" = "$IMAGE_SBOM_SHA256"

SOURCE_HEAD="$(git -C "$SOURCE_CHECKOUT" rev-parse --verify 'HEAD^{commit}')"
test "$SOURCE_HEAD" = "$RELEASE_COMMIT"
SOURCE_PACKAGE_JSON="$(git -C "$SOURCE_CHECKOUT" show "$RELEASE_COMMIT:package.json")"
jq -e --arg release_version "$RELEASE_VERSION" \
  '.name == "@hasna/emails" and .version == $release_version' \
  <<<"$SOURCE_PACKAGE_JSON" >/dev/null
ACTUAL_SOURCE_ARCHIVE_SHA256="$(git -C "$SOURCE_CHECKOUT" archive --format=zip "$RELEASE_COMMIT" \
  | sha256sum | awk '{print $1}')"
test "$ACTUAL_SOURCE_ARCHIVE_SHA256" = "$SOURCE_ARCHIVE_SHA256"

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

EXPECTED_TOPOLOGY_KEYS='["account_id","api_container_name","api_execution_role_arn","api_service","api_task_definition","api_task_role_arn","cluster","dlq_arn","dlq_url","environment","image_digest","image_reference","image_repository","live","migration_container_name","migration_execution_role_arn","migration_task_definition","migration_task_role_arn","private_subnet_ids","purpose","queue_arn","queue_url","region","release_commit","release_version","runtime_architecture","schema_version","source_archive_sha256","task_security_group_id","worker_container_name","worker_execution_role_arn","worker_service","worker_task_definition","worker_task_role_arn"]'
TOPOLOGY_JSON="$(jq -ceS --argjson expected_keys "$EXPECTED_TOPOLOGY_KEYS" \
  --arg release_version "$RELEASE_VERSION" --arg release_commit "$RELEASE_COMMIT" \
  --arg source_archive_sha256 "$SOURCE_ARCHIVE_SHA256" \
  --arg image_repository "$IMAGE_REPOSITORY" --arg image_digest "$IMAGE_DIGEST" \
  --arg image_reference "$IMAGE_REFERENCE" '
  select(type == "object")
  | select((keys | sort) == $expected_keys)
  | select(.schema_version == 1 and .purpose == "isolated-rehearsal")
  | select(.environment == "rehearsal" and .live == false)
  | select(.release_version == $release_version and .release_commit == $release_commit)
  | select(.source_archive_sha256 == $source_archive_sha256)
  | select(.image_repository == $image_repository and .image_digest == $image_digest)
  | select(.image_reference == $image_reference)
  | select(.runtime_architecture == "X86_64")
  | select(.account_id | type == "string" and test("^[0-9]{12}$"))
  | select(.region | type == "string" and test("^[a-z]{2}(-[a-z]+)+-[0-9]+$"))
  | select(all([
      .cluster, .api_service, .worker_service,
      .api_task_definition, .worker_task_definition, .migration_task_definition,
      .api_container_name, .worker_container_name, .migration_container_name,
      .api_task_role_arn, .worker_task_role_arn, .migration_task_role_arn,
      .api_execution_role_arn, .worker_execution_role_arn, .migration_execution_role_arn,
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
MANIFEST_API_CONTAINER_NAME="$(jq -r '.api_container_name' <<<"$TOPOLOGY_JSON")"
MANIFEST_WORKER_CONTAINER_NAME="$(jq -r '.worker_container_name' <<<"$TOPOLOGY_JSON")"
MANIFEST_MIGRATION_CONTAINER_NAME="$(jq -r '.migration_container_name' <<<"$TOPOLOGY_JSON")"
MANIFEST_API_TASK_ROLE_ARN="$(jq -r '.api_task_role_arn' <<<"$TOPOLOGY_JSON")"
MANIFEST_WORKER_TASK_ROLE_ARN="$(jq -r '.worker_task_role_arn' <<<"$TOPOLOGY_JSON")"
MANIFEST_MIGRATION_TASK_ROLE_ARN="$(jq -r '.migration_task_role_arn' <<<"$TOPOLOGY_JSON")"
MANIFEST_API_EXECUTION_ROLE_ARN="$(jq -r '.api_execution_role_arn' <<<"$TOPOLOGY_JSON")"
MANIFEST_WORKER_EXECUTION_ROLE_ARN="$(jq -r '.worker_execution_role_arn' <<<"$TOPOLOGY_JSON")"
MANIFEST_MIGRATION_EXECUTION_ROLE_ARN="$(jq -r '.migration_execution_role_arn' <<<"$TOPOLOGY_JSON")"
MANIFEST_QUEUE_URL="$(jq -r '.queue_url' <<<"$TOPOLOGY_JSON")"
MANIFEST_QUEUE_ARN="$(jq -r '.queue_arn' <<<"$TOPOLOGY_JSON")"
MANIFEST_DLQ_URL="$(jq -r '.dlq_url' <<<"$TOPOLOGY_JSON")"
MANIFEST_DLQ_ARN="$(jq -r '.dlq_arn' <<<"$TOPOLOGY_JSON")"
MANIFEST_SUBNETS="$(jq -cS '.private_subnet_ids | sort' <<<"$TOPOLOGY_JSON")"
MANIFEST_TASK_SG="$(jq -r '.task_security_group_id' <<<"$TOPOLOGY_JSON")"

test -n "$IMAGE_REFERENCE"
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

assert_task_identity() {
  task_json="$1"
  definition="$2"
  task_role="$3"
  execution_role="$4"
  container_name="$5"
  jq -e --arg definition "$definition" --arg task_role "$task_role" \
    --arg execution_role "$execution_role" --arg container_name "$container_name" '
    (.taskDefinition.taskDefinitionArn == $definition)
    and (.taskDefinition.taskRoleArn == $task_role)
    and (.taskDefinition.executionRoleArn == $execution_role)
    and (.taskDefinition.containerDefinitions | length == 1)
    and (.taskDefinition.containerDefinitions[0].name == $container_name)
  ' <<<"$task_json" >/dev/null
}

assert_task_identity "$API_TASK_PREFLIGHT_JSON" "$MANIFEST_API_TASK_DEFINITION" \
  "$MANIFEST_API_TASK_ROLE_ARN" "$MANIFEST_API_EXECUTION_ROLE_ARN" "$MANIFEST_API_CONTAINER_NAME"
assert_task_identity "$WORKER_TASK_PREFLIGHT_JSON" "$MANIFEST_WORKER_TASK_DEFINITION" \
  "$MANIFEST_WORKER_TASK_ROLE_ARN" "$MANIFEST_WORKER_EXECUTION_ROLE_ARN" "$MANIFEST_WORKER_CONTAINER_NAME"
assert_task_identity "$MIGRATION_TASK_PREFLIGHT_JSON" "$MANIFEST_MIGRATION_TASK_DEFINITION" \
  "$MANIFEST_MIGRATION_TASK_ROLE_ARN" "$MANIFEST_MIGRATION_EXECUTION_ROLE_ARN" \
  "$MANIFEST_MIGRATION_CONTAINER_NAME"

IMAGE_REGISTRY="${IMAGE_REPOSITORY%%/*}"
ECR_REPOSITORY_NAME="${IMAGE_REPOSITORY#*/}"
test "$ECR_REPOSITORY_NAME" != "$IMAGE_REPOSITORY"
case "$IMAGE_REGISTRY" in
  "${MANIFEST_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"|\
  "${MANIFEST_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com.cn") ;;
  *) printf '%s\n' "image repository is not in the reviewed account and region" >&2; exit 64 ;;
esac

IMAGE_DETAILS_JSON="$(rehearsal_aws ecr describe-images --region "$AWS_REGION" \
  --registry-id "$MANIFEST_ACCOUNT_ID" --repository-name "$ECR_REPOSITORY_NAME" \
  --image-ids "imageDigest=$IMAGE_DIGEST" --output json)"
jq -e --arg image_digest "$IMAGE_DIGEST" '
  (.imageDetails | length == 1)
  and (.imageDetails[0].imageDigest == $image_digest)
' <<<"$IMAGE_DETAILS_JSON" >/dev/null

# ECR Basic Scanning does not support scratch images, and its legacy summary
# fields are not authoritative here. Require a pinned independent scanner report
# and SBOM generated from the exact immutable registry reference instead.
jq -e --arg image_reference "$IMAGE_REFERENCE" '
  (.ArtifactName == $image_reference)
  and (.Metadata | type == "object")
  and (.Metadata.RepoDigests | type == "array" and index($image_reference) != null)
  and (.Results | type == "array")
  and (([.Results[]? | select(.Class == "os-pkgs") | .Packages[]?] | length) > 0)
  and (([.Results[]? | select(.Class == "lang-pkgs") | .Packages[]?] | length) > 0)
  and (([
    .Results[]?.Vulnerabilities[]?
    | select(.Severity == "CRITICAL" or .Severity == "HIGH")
  ] | length) == 0)
' "$IMAGE_SECURITY_REPORT" >/dev/null
jq -e --arg image_reference "$IMAGE_REFERENCE" '
  (.bomFormat == "CycloneDX")
  and (.specVersion | type == "string")
  and (.components | type == "array" and length > 0)
  and (([
    .metadata.component.properties[]?
    | select(.name == "aquasecurity:trivy:RepoDigest" and .value == $image_reference)
  ] | length) == 1)
' "$IMAGE_SBOM" >/dev/null

IMAGE_MANIFEST_JSON="$(rehearsal_aws ecr batch-get-image --region "$AWS_REGION" \
  --registry-id "$MANIFEST_ACCOUNT_ID" --repository-name "$ECR_REPOSITORY_NAME" \
  --image-ids "imageDigest=$IMAGE_DIGEST" \
  --accepted-media-types application/vnd.oci.image.manifest.v1+json \
    application/vnd.docker.distribution.manifest.v2+json \
  --query 'images[0].imageManifest' --output text)"
IMAGE_CONFIG_DIGEST="$(jq -er '.config.digest | select(test("^sha256:[0-9a-f]{64}$"))' \
  <<<"$IMAGE_MANIFEST_JSON")"
IMAGE_CONFIG_URL="$(rehearsal_aws ecr get-download-url-for-layer --region "$AWS_REGION" \
  --registry-id "$MANIFEST_ACCOUNT_ID" --repository-name "$ECR_REPOSITORY_NAME" \
  --layer-digest "$IMAGE_CONFIG_DIGEST" --query downloadUrl --output text)"
IMAGE_CONFIG_JSON="$(curl --fail --silent --show-error "$IMAGE_CONFIG_URL")"
jq -e --arg release_commit "$RELEASE_COMMIT" --arg release_version "$RELEASE_VERSION" '
  (.architecture == "amd64")
  and (.os == "linux")
  and (.config.Labels["org.opencontainers.image.revision"] == $release_commit)
  and (.config.Labels["org.opencontainers.image.version"] == $release_version)
' <<<"$IMAGE_CONFIG_JSON" >/dev/null

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

# Register only reviewed release definitions. Neither service may be updated by
# this targeted plan, and all desired counts remain unchanged at this point.
rehearsal_terraform plan -var-file="$TFVARS" -var="container_image=$IMAGE_REFERENCE" \
  -var="container_architecture=X86_64" \
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

STAGED_MIGRATION_TASK_JSON="$(rehearsal_aws ecs describe-task-definition --region "$AWS_REGION" \
  --task-definition "$MIGRATION_DEF" --output json)"
STAGED_WORKER_TASK_JSON="$(rehearsal_aws ecs describe-task-definition --region "$AWS_REGION" \
  --task-definition "$WORKER_DEF" --output json)"
STAGED_API_TASK_JSON="$(rehearsal_aws ecs describe-task-definition --region "$AWS_REGION" \
  --task-definition "$API_DEF" --output json)"

assert_staged_task_definition() {
  task_json="$1"
  definition="$2"
  task_role="$3"
  execution_role="$4"
  container_name="$5"
  jq -e --arg definition "$definition" --arg task_role "$task_role" \
    --arg execution_role "$execution_role" --arg container_name "$container_name" \
    --arg image_reference "$IMAGE_REFERENCE" '
    (.taskDefinition.taskDefinitionArn == $definition)
    and (.taskDefinition.taskRoleArn == $task_role)
    and (.taskDefinition.executionRoleArn == $execution_role)
    and (.taskDefinition.runtimePlatform.cpuArchitecture == "X86_64")
    and (.taskDefinition.runtimePlatform.operatingSystemFamily == "LINUX")
    and (.taskDefinition.containerDefinitions | length == 1)
    and (.taskDefinition.containerDefinitions[0].name == $container_name)
    and (.taskDefinition.containerDefinitions[0].image == $image_reference)
  ' <<<"$task_json" >/dev/null
}

assert_staged_task_definition "$STAGED_MIGRATION_TASK_JSON" "$MIGRATION_DEF" \
  "$MANIFEST_MIGRATION_TASK_ROLE_ARN" "$MANIFEST_MIGRATION_EXECUTION_ROLE_ARN" \
  "$MANIFEST_MIGRATION_CONTAINER_NAME"
assert_staged_task_definition "$STAGED_WORKER_TASK_JSON" "$WORKER_DEF" \
  "$MANIFEST_WORKER_TASK_ROLE_ARN" "$MANIFEST_WORKER_EXECUTION_ROLE_ARN" \
  "$MANIFEST_WORKER_CONTAINER_NAME"
assert_staged_task_definition "$STAGED_API_TASK_JSON" "$API_DEF" \
  "$MANIFEST_API_TASK_ROLE_ARN" "$MANIFEST_API_EXECUTION_ROLE_ARN" \
  "$MANIFEST_API_CONTAINER_NAME"

ROLLBACK_DISABLE_WORKER_JSON="$(rehearsal_aws ecs update-service --region "$AWS_REGION" \
  --cluster "$CLUSTER" --service "$WORKER_SERVICE" \
  --deployment-configuration "deploymentCircuitBreaker={enable=true,rollback=false},minimumHealthyPercent=$WORKER_MIN,maximumPercent=$WORKER_MAX" \
  --output json)"
ROLLBACK_DISABLE_API_JSON="$(rehearsal_aws ecs update-service --region "$AWS_REGION" \
  --cluster "$CLUSTER" --service "$API_SERVICE" \
  --deployment-configuration "deploymentCircuitBreaker={enable=true,rollback=false},minimumHealthyPercent=$API_MIN,maximumPercent=$API_MAX" \
  --output json)"
jq -e '.service.deploymentConfiguration.deploymentCircuitBreaker.rollback == false' \
  <<<"$ROLLBACK_DISABLE_WORKER_JSON" >/dev/null
jq -e '.service.deploymentConfiguration.deploymentCircuitBreaker.rollback == false' \
  <<<"$ROLLBACK_DISABLE_API_JSON" >/dev/null
aws ecs wait services-stable --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$WORKER_SERVICE" "$API_SERVICE"

ROLLBACK_DISABLED_JSON="$(aws ecs describe-services --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$WORKER_SERVICE" "$API_SERVICE" --output json)"
jq -e --arg worker "$WORKER_SERVICE" --arg api "$API_SERVICE" '
  (.failures | length) == 0
  and (.services | length == 2)
  and all(.services[];
    (.serviceName == $worker or .serviceName == $api)
    and .deploymentConfiguration.deploymentCircuitBreaker.rollback == false)
' <<<"$ROLLBACK_DISABLED_JSON" >/dev/null

rehearsal_aws ecs update-service --region "$AWS_REGION" --cluster "$CLUSTER" \
  --service "$WORKER_SERVICE" --desired-count 0
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
  --service "$API_SERVICE" --desired-count 0
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
# This exact release one-shot does not query migration 0017 tables and is safe
# before the ledger advances.
FENCE_OVERRIDES='{"containerOverrides":[{"name":"worker","command":["src/server/index.ts","inbound-provenance-fence"]}]}'
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
and empty-task-list checks before the release one-shot captures `FENCE_AT`. Record
the service JSON, task counts, queue/DLQ counts, and PostgreSQL-derived cutoff.

### 2. Migrate and verify ledger 0017

The three reviewed release definitions are already staged, every old task is
machine-proven absent, the stable queue in-flight gate passed, and only then was
the database-clock fence recorded. Automatic rollback stays disabled.

```bash
set -euo pipefail

MIGRATION_TASK="$(rehearsal_aws ecs run-task --region "$AWS_REGION" --cluster "$CLUSTER" \
  --launch-type FARGATE --task-definition "$MIGRATION_DEF" \
  --network-configuration "$NETWORK" --count 1 \
  --query 'tasks[0].taskArn' --output text)"
aws ecs wait tasks-stopped --region "$AWS_REGION" --cluster "$CLUSTER" --tasks "$MIGRATION_TASK"
MIGRATION_TASK_JSON="$(aws ecs describe-tasks --region "$AWS_REGION" --cluster "$CLUSTER" \
  --tasks "$MIGRATION_TASK" --output json)"
MIGRATION_EXIT="$(jq -er --arg container "$MANIFEST_MIGRATION_CONTAINER_NAME" \
  '.tasks[0].containers[] | select(.name == $container) | .exitCode' <<<"$MIGRATION_TASK_JSON")"
test "$MIGRATION_EXIT" = "0"

STATUS_OVERRIDES="$(jq -cn --arg container "$MANIFEST_MIGRATION_CONTAINER_NAME" \
  '{containerOverrides:[{name:$container,command:["src/cli/index.tsx","--json","db","status"]}]}')"
STATUS_TASK="$(rehearsal_aws ecs run-task --region "$AWS_REGION" --cluster "$CLUSTER" \
  --launch-type FARGATE --task-definition "$MIGRATION_DEF" \
  --network-configuration "$NETWORK" --count 1 \
  --overrides "$STATUS_OVERRIDES" \
  --query 'tasks[0].taskArn' --output text)"
aws ecs wait tasks-stopped --region "$AWS_REGION" --cluster "$CLUSTER" --tasks "$STATUS_TASK"
STATUS_TASK_JSON="$(aws ecs describe-tasks --region "$AWS_REGION" --cluster "$CLUSTER" \
  --tasks "$STATUS_TASK" --output json)"
STATUS_EXIT="$(jq -er --arg container "$MANIFEST_MIGRATION_CONTAINER_NAME" \
  '.tasks[0].containers[] | select(.name == $container) | .exitCode' <<<"$STATUS_TASK_JSON")"
test "$STATUS_EXIT" = "0"

MIGRATION_LOG_GROUP="$(jq -er --arg container "$MANIFEST_MIGRATION_CONTAINER_NAME" '
  .taskDefinition.containerDefinitions[] | select(.name == $container)
  | .logConfiguration.options["awslogs-group"]
' <<<"$STAGED_MIGRATION_TASK_JSON")"
MIGRATION_LOG_STREAM_PREFIX="$(jq -er --arg container "$MANIFEST_MIGRATION_CONTAINER_NAME" '
  .taskDefinition.containerDefinitions[] | select(.name == $container)
  | .logConfiguration.options["awslogs-stream-prefix"]
' <<<"$STAGED_MIGRATION_TASK_JSON")"
STATUS_TASK_ID="${STATUS_TASK##*/}"
STATUS_LOG_STREAM="${MIGRATION_LOG_STREAM_PREFIX}/${MANIFEST_MIGRATION_CONTAINER_NAME}/${STATUS_TASK_ID}"
STATUS_JSON=""
for attempt in $(seq 1 12); do
  STATUS_LOG_EVENTS="$(aws logs get-log-events --region "$AWS_REGION" \
    --log-group-name "$MIGRATION_LOG_GROUP" --log-stream-name "$STATUS_LOG_STREAM" \
    --start-from-head --output json)"
  STATUS_JSON="$(jq -cer '
    [.events[].message | fromjson?
      | select((keys | sort) == ["alreadyApplied","applied","pending"])]
    | select(length == 1) | .[0]
  ' <<<"$STATUS_LOG_EVENTS" 2>/dev/null || true)"
  test -n "$STATUS_JSON" && break
  test "$attempt" -lt 12 || exit 1
  sleep 5
done
jq -e '
  ((keys | sort) == ["alreadyApplied","applied","pending"])
  and (.applied | type == "array" and length == 0)
  and (.pending | type == "array" and length == 0)
  and (.alreadyApplied | type == "array" and all(.[]; type == "string"))
  and (.alreadyApplied | index("0017_inbound_message_source_provenance") != null)
' <<<"$STATUS_JSON" >/dev/null
printf '%s\n' "$STATUS_JSON"
```

Both tasks must exit zero, and the exact status task's exact CloudWatch stream
must contain one object with only the source-defined `applied`, `alreadyApplied`,
and `pending` fields. The machine gate requires `pending: []`, no dry-run
applications, and `0017_inbound_message_source_provenance` in `alreadyApplied`.
`emails db status --json` emits that object only after `MigrationLedger` validates
every stored `schema_migrations` checksum; checksum drift exits before JSON and
therefore cannot satisfy this gate. Do not restart or scale any pre-0017 release
task after this point.

### 3. Start only the release worker, drain the buffer, and audit

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
  '{containerOverrides:[{name:"worker",command:["src/server/index.ts","inbound-provenance-audit","--since",$since]}]}')"
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
objects only through the reviewed release's canonical S3 replay, and rerun the
audit.
Never patch message or provenance rows manually.

### 4. Start the release API and reconcile Terraform

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
VERSION_JSON="$(curl --fail --silent --show-error "$EMAILS_API_URL/version")"
jq -e --arg release_version "$RELEASE_VERSION" '
  ((keys | sort) == ["mode","name","status","version"])
  and (.status == "ok")
  and (.name == "emails")
  and (.mode == "self_hosted")
  and (.version == $release_version)
' <<<"$VERSION_JSON" >/dev/null
READY_JSON="$(curl --fail --silent --show-error "$EMAILS_API_URL/ready")"
printf '%s\n' "$VERSION_JSON" "$READY_JSON"

rehearsal_terraform plan -var-file="$TFVARS" -var="container_image=$IMAGE_REFERENCE" \
  -var="container_architecture=X86_64" \
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
activation leaves the API at zero while the reviewed release worker continues
to protect the queue, or both services may be returned to zero for
investigation. Use only a corrected 0017-compatible image, repeat the
definition, ledger, worker, audit, and API gates, and reconcile Terraform. A
pre-0017 release is never a rollback image. Never remove or rewrite the 0017
ledger row.
