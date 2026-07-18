mock_provider "aws" {
  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "111122223333"
      arn        = "arn:aws:iam::111122223333:user/terraform-test"
      user_id    = "terraform-test"
    }
  }

  override_data {
    target = data.aws_partition.current
    values = {
      partition  = "aws"
      dns_suffix = "amazonaws.com"
    }
  }

  override_data {
    target = data.aws_availability_zones.available
    values = {
      names = ["us-east-1a", "us-east-1b", "us-east-1c"]
    }
  }

  override_data {
    target = data.aws_iam_policy_document.rds_monitoring_assume
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.ecs_tasks_assume
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.execution["api"]
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.execution["worker"]
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.execution["migration"]
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.api
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.worker
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.kms
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.inbound_bucket
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.inbound_topic
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.inbound_queue
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.lb_logs[0]
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_resource {
    target          = aws_secretsmanager_secret.database_url
    override_during = plan
    values = {
      arn = "arn:aws:secretsmanager:us-east-1:111122223333:secret:emails/database-url-test"
    }
  }

  override_resource {
    target          = aws_secretsmanager_secret.migration_database_url
    override_during = plan
    values = {
      arn = "arn:aws:secretsmanager:us-east-1:111122223333:secret:emails/migration-database-url-test"
    }
  }

  override_resource {
    target          = aws_secretsmanager_secret.api_signing_key
    override_during = plan
    values = {
      arn = "arn:aws:secretsmanager:us-east-1:111122223333:secret:emails/api-signing-key-test"
    }
  }

  override_resource {
    target          = aws_s3_bucket.inbound
    override_during = plan
    values = {
      id  = "emails-111122223333-us-east-1-inbound"
      arn = "arn:aws:s3:::emails-111122223333-us-east-1-inbound"
    }
  }

  override_resource {
    target          = aws_sqs_queue.inbound
    override_during = plan
    values = {
      id  = "https://sqs.us-east-1.amazonaws.com/111122223333/emails-inbound"
      arn = "arn:aws:sqs:us-east-1:111122223333:emails-inbound"
    }
  }
}

mock_provider "random" {}

run "dormant_by_default" {
  command = plan

  variables {
    aws_region          = "us-east-1"
    expected_account_id = "111122223333"
    container_image     = "registry.example/emails@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }

  assert {
    condition     = aws_ecs_service.api.desired_count == 0
    error_message = "The API must be dormant by default."
  }

  assert {
    condition     = aws_ecs_service.worker.desired_count == 0
    error_message = "The inbound worker must be dormant by default."
  }

  assert {
    condition     = length(aws_ses_receipt_rule.inbound) == 0
    error_message = "SES inbound resources must be opt-in."
  }

  assert {
    condition     = length(aws_lb.api) == 0
    error_message = "The public endpoint must be opt-in."
  }

  assert {
    condition     = length(aws_nat_gateway.this) == 0
    error_message = "A dormant deployment must not create billable NAT gateways."
  }

  assert {
    condition     = length(aws_lb.private) == 0
    error_message = "The private TLS endpoint must be opt-in."
  }

  assert {
    condition     = jsonencode(jsondecode(aws_ecs_task_definition.api.container_definitions)[0].command) == jsonencode(["src/server/index.ts"])
    error_message = "The API command must supply only arguments for the image-native Bun entrypoint."
  }

  assert {
    condition     = jsonencode(jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].command) == jsonencode(["src/server/index.ts", "ingest-worker"])
    error_message = "The worker command must supply only arguments for the image-native Bun entrypoint."
  }

  assert {
    condition     = jsonencode(jsondecode(aws_ecs_task_definition.migration.container_definitions)[0].command) == jsonencode(["src/cli/index.tsx", "db", "migrate"])
    error_message = "The migration command must supply only arguments for the image-native Bun entrypoint."
  }

  assert {
    condition = alltrue([
      for definition in [
        jsondecode(aws_ecs_task_definition.api.container_definitions)[0],
        jsondecode(aws_ecs_task_definition.worker.container_definitions)[0],
        jsondecode(aws_ecs_task_definition.migration.container_definitions)[0],
        ] : lookup({
          for entry in definition.environment : entry.name => entry.value
          }, "EMAILS_DATABASE_CA_FILE", "") == "/opt/emails/certs/aws-rds-global-bundle.pem" && lookup({
          for entry in definition.environment : entry.name => entry.value
      }, "NODE_EXTRA_CA_CERTS", "") == "/opt/emails/certs/aws-rds-global-bundle.pem"
    ])
    error_message = "Every task must use the CA paths shipped by the canonical Emails image."
  }

  assert {
    condition = one([
      for parameter in aws_db_parameter_group.this.parameter : parameter.value
      if parameter.name == "rds.force_ssl"
    ]) == "1"
    error_message = "RDS must reject plaintext PostgreSQL connections."
  }

  assert {
    condition = alltrue([
      for definition in [
        jsondecode(aws_ecs_task_definition.api.container_definitions)[0],
        jsondecode(aws_ecs_task_definition.worker.container_definitions)[0],
        jsondecode(aws_ecs_task_definition.migration.container_definitions)[0],
        ] : definition.readonlyRootFilesystem && anytrue([
          for mount in definition.mountPoints : mount.containerPath == "/tmp" && !mount.readOnly
      ])
    ])
    error_message = "Every task must use a read-only root with writable /tmp."
  }

  assert {
    condition = alltrue([
      for definition in [
        jsondecode(aws_ecs_task_definition.api.container_definitions)[0],
        jsondecode(aws_ecs_task_definition.worker.container_definitions)[0],
        jsondecode(aws_ecs_task_definition.migration.container_definitions)[0],
        ] : alltrue([
          for entry in concat(definition.environment, definition.secrets) :
          !strcontains(entry.name, "MAILERY") &&
          !contains(["DATABASE_URL", "API_KEY_SIGNING_SECRET"], entry.name)
      ])
    ])
    error_message = "Task definitions must reject legacy and generic secret environment names."
  }

  assert {
    condition = toset([
      for entry in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].secrets : entry.name
    ]) == toset(["EMAILS_DATABASE_URL", "EMAILS_API_SIGNING_KEY"])
    error_message = "The API must receive only canonical Emails secret environment names."
  }

  assert {
    condition = (
      jsondecode(aws_ecs_task_definition.api.container_definitions)[0].healthCheck.command[0] == "CMD" &&
      jsondecode(aws_ecs_task_definition.api.container_definitions)[0].healthCheck.command[1] == "/usr/local/bin/bun" &&
      jsondecode(aws_ecs_task_definition.api.container_definitions)[0].healthCheck.command[2] == "-e" &&
      strcontains(jsondecode(aws_ecs_task_definition.api.container_definitions)[0].healthCheck.command[3], "/ready")
    )
    error_message = "The API health check must invoke image-native Bun directly against /ready without a shell."
  }

  assert {
    condition = (
      aws_ecs_service.api.deployment_minimum_healthy_percent == 100 &&
      !aws_ecs_service.api.deployment_circuit_breaker[0].rollback &&
      !aws_ecs_service.worker.deployment_circuit_breaker[0].rollback
    )
    error_message = "Automatic rollback must be safely disabled until a tenant-aware deployment is proven."
  }
}

run "activation_is_blocked_without_readiness" {
  command = plan

  variables {
    aws_region          = "us-east-1"
    expected_account_id = "111122223333"
    container_image     = "registry.example/emails@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    api_desired_count   = 1
  }

  expect_failures = [
    aws_ecs_service.api,
  ]
}

run "automatic_rollback_is_blocked_before_migrations" {
  command = plan

  variables {
    aws_region                           = "us-east-1"
    expected_account_id                  = "111122223333"
    container_image                      = "registry.example/emails@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    enable_automatic_deployment_rollback = true
  }

  expect_failures = [
    aws_ecs_service.api,
    aws_ecs_service.worker,
  ]
}

run "primary_super_admin_bootstrap_is_paired_and_api_only" {
  command = plan

  variables {
    aws_region                        = "us-east-1"
    expected_account_id               = "111122223333"
    container_image                   = "registry.example/emails@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    primary_super_admin_email         = "owner@example.com"
    primary_super_admin_bootstrap_kid = "operator-key-id"
  }

  assert {
    condition = lookup({
      for entry in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].environment : entry.name => entry.value
    }, "EMAILS_PRIMARY_SUPER_ADMIN_EMAIL", "") == "owner@example.com"
    error_message = "The API task must receive the explicitly pinned primary super-admin email."
  }

  assert {
    condition = lookup({
      for entry in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].environment : entry.name => entry.value
    }, "EMAILS_PRIMARY_SUPER_ADMIN_BOOTSTRAP_KID", "") == "operator-key-id"
    error_message = "The API task must receive the explicitly authorized bootstrap KID."
  }

  assert {
    condition = alltrue([
      for definition in [
        jsondecode(aws_ecs_task_definition.worker.container_definitions)[0],
        jsondecode(aws_ecs_task_definition.migration.container_definitions)[0],
        ] : alltrue([
          for entry in definition.environment : !startswith(entry.name, "EMAILS_PRIMARY_SUPER_ADMIN_")
      ])
    ])
    error_message = "Primary super-admin bootstrap settings must be API-only."
  }
}

run "primary_super_admin_email_without_kid_hard_fails" {
  command = plan

  variables {
    aws_region                = "us-east-1"
    expected_account_id       = "111122223333"
    container_image           = "registry.example/emails@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    primary_super_admin_email = "owner@example.com"
  }

  expect_failures = [aws_ecs_task_definition.api]
}

run "primary_super_admin_kid_without_email_hard_fails" {
  command = plan

  variables {
    aws_region                        = "us-east-1"
    expected_account_id               = "111122223333"
    container_image                   = "registry.example/emails@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    primary_super_admin_bootstrap_kid = "operator-key-id"
  }

  expect_failures = [aws_ecs_task_definition.api]
}

run "ready_activation_is_allowed" {
  command = plan

  variables {
    aws_region                    = "us-east-1"
    expected_account_id           = "111122223333"
    container_image               = "registry.example/emails@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    api_desired_count             = 2
    worker_desired_count          = 1
    secrets_ready                 = true
    migrations_complete           = true
    enable_nat_gateway            = true
    alarm_notification_topic_arn  = "arn:aws:sns:us-east-1:111122223333:operator-alerts"
    email_domain                  = "example.com"
    enable_ses_inbound            = true
    inbound_recipients            = ["example.com"]
    inbound_object_retention_days = 30
  }

  assert {
    condition     = aws_ecs_service.api.desired_count == 2
    error_message = "A fully acknowledged deployment should permit the requested API count."
  }

  assert {
    condition     = aws_ecs_service.worker.desired_count == 1
    error_message = "A fully acknowledged deployment should permit the requested worker count."
  }

  assert {
    condition     = length(aws_nat_gateway.this) == 2
    error_message = "The default production activation should provide one NAT gateway per AZ."
  }

  assert {
    condition = (
      !aws_ecs_service.api.deployment_circuit_breaker[0].rollback &&
      !aws_ecs_service.worker.deployment_circuit_breaker[0].rollback
    )
    error_message = "The first tenant-aware activation must remain roll-forward-only by default."
  }
}

run "tenant_aware_steady_state_enables_automatic_rollback" {
  command = plan

  variables {
    aws_region                           = "us-east-1"
    expected_account_id                  = "111122223333"
    container_image                      = "registry.example/emails@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    api_desired_count                    = 2
    worker_desired_count                 = 1
    secrets_ready                        = true
    migrations_complete                  = true
    enable_nat_gateway                   = true
    alarm_notification_topic_arn         = "arn:aws:sns:us-east-1:111122223333:operator-alerts"
    email_domain                         = "example.com"
    enable_ses_inbound                   = true
    inbound_recipients                   = ["example.com"]
    inbound_object_retention_days        = 30
    enable_automatic_deployment_rollback = true
  }

  assert {
    condition = (
      aws_ecs_service.api.deployment_circuit_breaker[0].rollback &&
      aws_ecs_service.worker.deployment_circuit_breaker[0].rollback
    )
    error_message = "An explicit tenant-aware steady-state acknowledgement must enable API and worker rollback together."
  }
}

run "optional_public_and_ses_resources" {
  command = plan

  variables {
    aws_region                    = "us-east-1"
    expected_account_id           = "111122223333"
    container_image               = "registry.example/emails@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    enable_public_endpoint        = true
    service_domain                = "emails.example.com"
    certificate_arn               = "arn:aws:acm:us-east-1:111122223333:certificate/00000000-0000-0000-0000-000000000000"
    email_domain                  = "example.com"
    enable_ses_inbound            = true
    inbound_recipients            = ["example.com"]
    inbound_object_retention_days = 30
  }

  assert {
    condition     = length(aws_lb.api) == 1
    error_message = "Public exposure should create exactly one ALB only when explicitly enabled."
  }

  assert {
    condition     = length(aws_ses_receipt_rule.inbound) == 1
    error_message = "SES inbound should create exactly one dormant receipt rule only when explicitly enabled."
  }


  assert {
    condition     = length(aws_wafv2_web_acl.public) == 1 && length(aws_s3_bucket.lb_logs) == 1
    error_message = "Public exposure must always create WAF rate limiting and access logging."
  }
}

run "private_tls_endpoint" {
  command = plan

  variables {
    aws_region                        = "us-east-1"
    expected_account_id               = "111122223333"
    container_image                   = "registry.example/emails@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    enable_private_endpoint           = true
    private_service_domain            = "emails.internal.example.com"
    private_certificate_arn           = "arn:aws:acm:us-east-1:111122223333:certificate/11111111-1111-1111-1111-111111111111"
    private_client_security_group_ids = ["sg-0123456789abcdef0"]
  }

  assert {
    condition     = length(aws_lb.private) == 1 && aws_lb.private[0].internal
    error_message = "Private access must use an internal load balancer."
  }

  assert {
    condition     = output.private_api_url == "https://emails.internal.example.com"
    error_message = "Private clients must receive an HTTPS-only URL."
  }

  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.private_alb_clients) == 1
    error_message = "Private TLS ingress must be restricted to explicit client security groups."
  }
}

run "public_configuration_hard_fails" {
  command = plan

  variables {
    aws_region             = "us-east-1"
    expected_account_id    = "111122223333"
    container_image        = "registry.example/emails@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    enable_public_endpoint = true
  }

  expect_failures = [var.enable_public_endpoint]
}

run "private_configuration_hard_fails" {
  command = plan

  variables {
    aws_region              = "us-east-1"
    expected_account_id     = "111122223333"
    container_image         = "registry.example/emails@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    enable_private_endpoint = true
  }

  expect_failures = [var.enable_private_endpoint]
}

run "ses_retention_hard_fails" {
  command = plan

  variables {
    aws_region          = "us-east-1"
    expected_account_id = "111122223333"
    container_image     = "registry.example/emails@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    email_domain        = "example.com"
    enable_ses_inbound  = true
    inbound_recipients  = ["example.com"]
  }

  expect_failures = [var.enable_ses_inbound]
}

run "mutable_image_hard_fails" {
  command = plan

  variables {
    aws_region          = "us-east-1"
    expected_account_id = "111122223333"
    container_image     = "registry.example/emails:latest"
  }

  expect_failures = [var.container_image]
}

run "known_good_digest_is_plumbed_for_rollback" {
  command = plan

  variables {
    aws_region          = "us-east-1"
    expected_account_id = "111122223333"
    container_image     = "registry.example/emails@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  }

  assert {
    condition     = strcontains(aws_ecs_task_definition.api.container_definitions, "@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
    error_message = "A previous known-good digest must flow into a rollback task definition."
  }
}
