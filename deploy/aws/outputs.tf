output "operator_account_id" {
  description = "AWS account in which this deployment is allowed to operate."
  value       = data.aws_caller_identity.current.account_id
}

output "vpc_id" {
  description = "Dedicated Emails VPC ID."
  value       = aws_vpc.this.id
}

output "private_subnet_ids" {
  description = "Private subnet IDs used by RDS and Fargate."
  value       = aws_subnet.private[*].id
}

output "ecs_cluster_name" {
  description = "ECS cluster for operator commands."
  value       = aws_ecs_cluster.this.name
}

output "api_service_name" {
  description = "Exact API ECS service name for controlled cutover commands."
  value       = aws_ecs_service.api.name
}

output "worker_service_name" {
  description = "Exact inbound-worker ECS service name for controlled cutover commands."
  value       = aws_ecs_service.worker.name
}

output "api_task_definition_arn" {
  description = "Exact API task definition staged from the reviewed image."
  value       = aws_ecs_task_definition.api.arn
}

output "worker_task_definition_arn" {
  description = "Exact worker task definition staged from the reviewed image; also carries the canonical inbound bucket for read-only provenance audit tasks."
  value       = aws_ecs_task_definition.worker.arn
}

output "migration_task_definition_arn" {
  description = "One-shot database migration task definition. Run and verify it before enabling services."
  value       = aws_ecs_task_definition.migration.arn
}

output "ecs_task_security_group_id" {
  description = "Security group used when launching the migration task."
  value       = aws_security_group.tasks.id
}

output "database_endpoint" {
  description = "Private PostgreSQL endpoint used when constructing the least-privilege application DSN."
  value       = aws_db_instance.this.endpoint
}

output "database_master_secret_arn" {
  description = "AWS-managed RDS master secret for bootstrap only; never inject it into application tasks."
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
}

output "database_url_secret_arn" {
  description = "Empty Secrets Manager container that the operator must populate with the application DSN outside Terraform."
  value       = aws_secretsmanager_secret.database_url.arn
}

output "migration_database_url_secret_arn" {
  description = "Empty Secrets Manager container for a schema-owner DSN used only by the migration task."
  value       = aws_secretsmanager_secret.migration_database_url.arn
}

output "api_signing_key_secret_arn" {
  description = "Empty Secrets Manager container that the operator must populate with a high-entropy signing key outside Terraform."
  value       = aws_secretsmanager_secret.api_signing_key.arn
}

output "inbound_bucket_name" {
  description = "Private S3 bucket for raw inbound MIME."
  value       = aws_s3_bucket.inbound.id
}

output "inbound_queue_url" {
  description = "SQS queue consumed by the inbound worker."
  value       = aws_sqs_queue.inbound.id
}

output "inbound_dlq_url" {
  description = "Dead-letter queue requiring operator replay or remediation."
  value       = aws_sqs_queue.inbound_dlq.id
}

output "private_api_url" {
  description = "Private HTTPS API URL. Null unless the internal TLS endpoint is enabled."
  value       = var.enable_private_endpoint ? "https://${var.private_service_domain}" : null
}

output "public_api_url" {
  description = "Public HTTPS API URL. Null unless the optional public endpoint is enabled."
  value       = var.enable_public_endpoint ? "https://${var.service_domain}" : null
}

output "load_balancer_access_log_bucket" {
  description = "S3 access-log bucket for enabled public or private TLS endpoints."
  value       = local.any_endpoint_enabled ? aws_s3_bucket.lb_logs[0].id : null
}

output "public_waf_arn" {
  description = "WAF web ACL protecting the public endpoint."
  value       = var.enable_public_endpoint ? aws_wafv2_web_acl.public[0].arn : null
}

output "ses_identity_verification_token" {
  description = "DNS verification token when an SES identity is requested."
  value       = var.email_domain == null ? null : aws_ses_domain_identity.this[0].verification_token
  sensitive   = true
}

output "ses_dkim_tokens" {
  description = "DKIM tokens to publish when Route53 record creation is disabled."
  value       = var.email_domain == null ? [] : aws_ses_domain_dkim.this[0].dkim_tokens
}

output "ses_inbound_mx_value" {
  description = "MX value to publish only after receipt rules, worker, and mailbox verification."
  value       = var.enable_ses_inbound ? "10 inbound-smtp.${var.aws_region}.amazonaws.com" : null
}

output "ses_receipt_rule_set_name" {
  description = "Dormant receipt rule set name. Terraform deliberately does not activate it."
  value       = var.enable_ses_inbound ? aws_ses_receipt_rule_set.this[0].rule_set_name : null
}
