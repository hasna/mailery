resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${var.name}/api"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.this.arn
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/${var.name}/worker"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.this.arn
}

resource "aws_cloudwatch_log_group" "migration" {
  name              = "/ecs/${var.name}/migration"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.this.arn
}

resource "aws_ecs_cluster" "this" {
  name = var.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

locals {
  database_ca_file = "/opt/emails/certs/aws-rds-global-bundle.pem"

  common_environment = [
    { name = "AWS_REGION", value = var.aws_region },
    { name = "HOST", value = "0.0.0.0" },
    { name = "HOME", value = "/tmp" },
    { name = "PORT", value = tostring(local.api_port) },
    { name = "EMAILS_MODE", value = "self_hosted" },
    { name = "EMAILS_DATABASE_CA_FILE", value = local.database_ca_file },
    { name = "NODE_EXTRA_CA_CERTS", value = local.database_ca_file },
  ]

  api_environment = concat(
    local.common_environment,
    [{ name = "EMAILS_SEND_PROVIDER", value = var.send_provider }],
    var.primary_super_admin_email == null || var.primary_super_admin_bootstrap_kid == null ? [] : [
      { name = "EMAILS_PRIMARY_SUPER_ADMIN_EMAIL", value = var.primary_super_admin_email },
      { name = "EMAILS_PRIMARY_SUPER_ADMIN_BOOTSTRAP_KID", value = var.primary_super_admin_bootstrap_kid },
    ],
  )

  worker_environment = concat(local.common_environment, [
    { name = "EMAILS_INGEST_QUEUE_URL", value = aws_sqs_queue.inbound.id },
    { name = "EMAILS_INGEST_S3_BUCKET", value = aws_s3_bucket.inbound.id },
  ])

  database_secret = {
    name      = "EMAILS_DATABASE_URL"
    valueFrom = aws_secretsmanager_secret.database_url.arn
  }

  migration_database_secret = {
    name      = "EMAILS_DATABASE_URL"
    valueFrom = aws_secretsmanager_secret.migration_database_url.arn
  }

  signing_secret = {
    name      = "EMAILS_API_SIGNING_KEY"
    valueFrom = aws_secretsmanager_secret.api_signing_key.arn
  }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.api_cpu)
  memory                   = tostring(var.api_memory)
  execution_role_arn       = aws_iam_role.execution["api"].arn
  task_role_arn            = aws_iam_role.api.arn

  runtime_platform {
    cpu_architecture        = var.container_architecture
    operating_system_family = "LINUX"
  }

  lifecycle {
    precondition {
      condition     = (var.primary_super_admin_email == null) == (var.primary_super_admin_bootstrap_kid == null)
      error_message = "primary_super_admin_email and primary_super_admin_bootstrap_kid must be configured together."
    }
  }

  volume { name = "tmp" }

  container_definitions = jsonencode([{
    name                   = "api"
    image                  = var.container_image
    essential              = true
    user                   = "bun"
    readonlyRootFilesystem = true
    command                = ["src/server/index.ts"]
    stopTimeout            = 120
    environment            = local.api_environment
    secrets                = [local.database_secret, local.signing_secret]
    linuxParameters        = { initProcessEnabled = true }
    mountPoints = [{
      sourceVolume  = "tmp"
      containerPath = "/tmp"
      readOnly      = false
    }]
    portMappings = [{
      name          = "http"
      containerPort = local.api_port
      hostPort      = local.api_port
      protocol      = "tcp"
    }]
    healthCheck = {
      command     = ["CMD", "/usr/local/bin/bun", "-e", "const port=Number(process.env.PORT||8080);const r=await fetch('http://127.0.0.1:'+port+'/ready');process.exit(r.ok?0:1)"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.api.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "api"
      }
    }
  }])
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.worker_cpu)
  memory                   = tostring(var.worker_memory)
  execution_role_arn       = aws_iam_role.execution["worker"].arn
  task_role_arn            = aws_iam_role.worker.arn

  runtime_platform {
    cpu_architecture        = var.container_architecture
    operating_system_family = "LINUX"
  }

  volume { name = "tmp" }

  container_definitions = jsonencode([{
    name                   = "worker"
    image                  = var.container_image
    essential              = true
    user                   = "bun"
    readonlyRootFilesystem = true
    command                = ["src/server/index.ts", "ingest-worker"]
    stopTimeout            = 120
    environment            = local.worker_environment
    secrets                = [local.database_secret]
    linuxParameters        = { initProcessEnabled = true }
    mountPoints = [{
      sourceVolume  = "tmp"
      containerPath = "/tmp"
      readOnly      = false
    }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.worker.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "worker"
      }
    }
  }])
}

resource "aws_ecs_task_definition" "migration" {
  family                   = "${var.name}-migration"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.migration_cpu)
  memory                   = tostring(var.migration_memory)
  execution_role_arn       = aws_iam_role.execution["migration"].arn
  task_role_arn            = aws_iam_role.migration.arn

  runtime_platform {
    cpu_architecture        = var.container_architecture
    operating_system_family = "LINUX"
  }

  volume { name = "tmp" }

  container_definitions = jsonencode([{
    name                   = "migration"
    image                  = var.container_image
    essential              = true
    user                   = "bun"
    readonlyRootFilesystem = true
    command                = ["src/cli/index.tsx", "db", "migrate"]
    environment            = local.common_environment
    secrets                = [local.migration_database_secret]
    linuxParameters        = { initProcessEnabled = true }
    mountPoints = [{
      sourceVolume  = "tmp"
      containerPath = "/tmp"
      readOnly      = false
    }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.migration.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "migration"
      }
    }
  }])
}

resource "aws_ecs_service" "api" {
  name            = "${var.name}-api"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_desired_count

  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  enable_execute_command             = var.enable_execute_command
  health_check_grace_period_seconds  = local.any_endpoint_enabled ? 120 : null
  wait_for_steady_state              = true

  deployment_circuit_breaker {
    enable   = true
    rollback = var.enable_automatic_deployment_rollback
  }

  network_configuration {
    assign_public_ip = false
    security_groups  = [aws_security_group.tasks.id]
    subnets          = aws_subnet.private[*].id
  }

  dynamic "load_balancer" {
    for_each = var.enable_public_endpoint ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.api[0].arn
      container_name   = "api"
      container_port   = local.api_port
    }
  }

  dynamic "load_balancer" {
    for_each = var.enable_private_endpoint ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.private[0].arn
      container_name   = "api"
      container_port   = local.api_port
    }
  }

  lifecycle {
    precondition {
      condition     = !var.enable_automatic_deployment_rollback || var.migrations_complete
      error_message = "Automatic rollback cannot be enabled before migrations_complete; keep the sealed cutover roll-forward-only."
    }

    precondition {
      condition = var.api_desired_count == 0 || (
        var.secrets_ready &&
        var.migrations_complete &&
        var.enable_nat_gateway &&
        local.alarm_topic_is_operator_owned &&
        var.email_domain != null
      )
      error_message = "Starting the API requires populated secrets, completed migrations, NAT egress, an operator-owned alarm topic, and an SES email_domain."
    }
  }

  timeouts {
    create = "20m"
    update = "20m"
    delete = "20m"
  }

  depends_on = [
    aws_ecs_cluster_capacity_providers.this,
    aws_lb_listener.https,
    aws_lb_listener.private_https,
    aws_wafv2_web_acl_association.public,
  ]
}

resource "aws_ecs_service" "worker" {
  name            = "${var.name}-worker"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.worker_desired_count

  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  enable_execute_command             = var.enable_execute_command
  wait_for_steady_state              = true

  deployment_circuit_breaker {
    enable   = true
    rollback = var.enable_automatic_deployment_rollback
  }

  network_configuration {
    assign_public_ip = false
    security_groups  = [aws_security_group.tasks.id]
    subnets          = aws_subnet.private[*].id
  }

  lifecycle {
    precondition {
      condition     = !var.enable_automatic_deployment_rollback || var.migrations_complete
      error_message = "Automatic rollback cannot be enabled before migrations_complete; keep the sealed cutover roll-forward-only."
    }

    precondition {
      condition = var.worker_desired_count == 0 || (
        var.secrets_ready &&
        var.migrations_complete &&
        var.enable_nat_gateway &&
        local.alarm_topic_is_operator_owned &&
        var.enable_ses_inbound
      )
      error_message = "Starting the worker requires populated secrets, completed migrations, NAT egress, an operator-owned alarm topic, and enabled SES inbound."
    }
  }

  timeouts {
    create = "20m"
    update = "20m"
    delete = "20m"
  }

  depends_on = [aws_ecs_cluster_capacity_providers.this]
}
