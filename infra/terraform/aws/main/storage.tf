# Backups (14-day retention) and release tarballs (30-day retention).
resource "aws_s3_bucket" "data" {
  bucket = "${local.name}-data-${local.account}"
}

resource "aws_s3_bucket_public_access_block" "data" {
  bucket                  = aws_s3_bucket.data.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "data" {
  bucket = aws_s3_bucket.data.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "data" {
  bucket = aws_s3_bucket.data.id
  rule {
    id     = "backups"
    status = "Enabled"
    filter { prefix = "backups/" }
    expiration { days = var.backup_retention_days }
  }
  rule {
    id     = "rolling-backups"
    status = "Enabled"
    filter { prefix = "backups/rolling/" }
    expiration { days = 2 }
  }
  rule {
    id     = "releases"
    status = "Enabled"
    filter { prefix = "releases/" }
    expiration { days = 30 }
  }
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/agentcraft/app"
  retention_in_days = 7
}

resource "aws_cloudwatch_log_group" "host" {
  name              = "/agentcraft/host"
  retention_in_days = 7
}

resource "random_password" "rcon" {
  length  = 32
  special = false
}

resource "aws_ssm_parameter" "rcon" {
  name  = "/agentcraft/rcon-password"
  type  = "SecureString"
  value = random_password.rcon.result
}

resource "aws_ssm_parameter" "ignore_season" {
  name  = "/agentcraft/ignore-season"
  type  = "String"
  value = "0"
  lifecycle { ignore_changes = [value] } # "1" = agents play outside season hours (read at every boot)
}

resource "aws_ssm_parameter" "release" {
  name  = "/agentcraft/release"
  type  = "String"
  value = "none"
  lifecycle { ignore_changes = [value] } # set by scripts/deploy.sh
}
