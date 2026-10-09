# Credit guard: hourly check of the Free Tier credit balance + budget alert handler.
# Below the floor (or on a 100% budget alert) it scales the host to zero, blocks the
# schedule from waking it again, and posts to #ops. This is what makes "never spend
# real money" hold even if the host itself is broken.
data "archive_file" "guard" {
  type        = "zip"
  source_file = "${path.module}/lambda/guard.py"
  output_path = "${path.module}/.build/guard.zip"
}

resource "aws_lambda_function" "guard" {
  function_name    = "${local.name}-guard"
  role             = aws_iam_role.guard.arn
  runtime          = "python3.13"
  architectures    = ["arm64"]
  handler          = "guard.handler"
  filename         = data.archive_file.guard.output_path
  source_code_hash = data.archive_file.guard.output_base64sha256
  timeout          = 60
  memory_size      = 128
  environment {
    variables = {
      ASG_NAME         = aws_autoscaling_group.host.name
      CREDIT_FLOOR_USD = tostring(var.credit_floor_usd)
      DISCORD_SECRET   = "agentcraft/discord"
    }
  }
}

resource "aws_cloudwatch_log_group" "guard" {
  name              = "/aws/lambda/${aws_lambda_function.guard.function_name}"
  retention_in_days = 14
}

resource "aws_scheduler_schedule" "guard" {
  name                = "${local.name}-credit-guard"
  schedule_expression = "rate(1 hour)"
  flexible_time_window { mode = "OFF" }
  target {
    arn      = aws_lambda_function.guard.arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ source = "schedule" })
  }
}

# ---------------------------------------------------------------- budgets -> SNS -> guard
resource "aws_sns_topic" "budget" {
  name = "${local.name}-budget"
}

data "aws_iam_policy_document" "budget_topic" {
  statement {
    actions   = ["SNS:Publish"]
    resources = [aws_sns_topic.budget.arn]
    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account]
    }
  }
}

resource "aws_sns_topic_policy" "budget" {
  arn    = aws_sns_topic.budget.arn
  policy = data.aws_iam_policy_document.budget_topic.json
}

resource "aws_sns_topic_subscription" "budget_guard" {
  topic_arn = aws_sns_topic.budget.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.guard.arn
}

resource "aws_lambda_permission" "sns" {
  statement_id  = "sns-budget"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.guard.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.budget.arn
}

locals {
  budgets = {
    hosting = { amount = var.hosting_budget_usd, filter = "NotEquals" }
    llm     = { amount = var.llm_budget_usd, filter = "Equals" }
  }
}

# Budgets track gross cost (credits excluded) so the alarms reflect real burn rate.
resource "aws_budgets_budget" "this" {
  for_each     = local.budgets
  name         = "${local.name}-${each.key}"
  budget_type  = "COST"
  limit_amount = tostring(each.value.amount)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_types {
    include_credit = false
    include_refund = false
  }

  dynamic "cost_filter" {
    for_each = each.value.filter == "Equals" ? [1] : []
    content {
      name   = "Service"
      values = ["Amazon Bedrock"]
    }
  }

  dynamic "notification" {
    for_each = [50, 80, 100]
    content {
      comparison_operator       = "GREATER_THAN"
      threshold                 = notification.value
      threshold_type            = "PERCENTAGE"
      notification_type         = "ACTUAL"
      subscriber_sns_topic_arns = [aws_sns_topic.budget.arn]
    }
  }
}
