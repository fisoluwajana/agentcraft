# Every role here carries the same permissions boundary as the ceiling.
resource "aws_iam_policy" "boundary" {
  name   = "${local.name}-boundary"
  policy = replace(file("${path.module}/../../../aws/bootstrap/policies/agentcraft-boundary.json"), "__ACCOUNT_ID__", local.account)
}

# ---------------------------------------------------------------- instance role
data "aws_iam_policy_document" "ec2_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "host" {
  name                 = "${local.name}-host"
  assume_role_policy   = data.aws_iam_policy_document.ec2_trust.json
  permissions_boundary = aws_iam_policy.boundary.arn
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.host.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "host" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
    resources = ["${aws_cloudwatch_log_group.app.arn}:*", "${aws_cloudwatch_log_group.host.arn}:*"]
  }
  statement {
    sid       = "DataBucket"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:ListBucket"]
    resources = [aws_s3_bucket.data.arn, "${aws_s3_bucket.data.arn}/*"]
  }
  statement {
    sid       = "Secrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["arn:aws:secretsmanager:${var.region}:${local.account}:secret:agentcraft/*"]
  }
  statement {
    sid       = "Params"
    actions   = ["ssm:GetParameter", "ssm:GetParameters"]
    resources = ["arn:aws:ssm:${var.region}:${local.account}:parameter/agentcraft/*"]
  }
  statement {
    sid       = "Bedrock"
    actions   = ["bedrock-mantle:*", "bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
    resources = ["*"]
  }
  statement {
    sid       = "AttachWorldVolume"
    actions   = ["ec2:AttachVolume", "ec2:DetachVolume"]
    resources = [aws_ebs_volume.world.arn, "arn:aws:ec2:${var.region}:${local.account}:instance/*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/project"
      values   = ["agentcraft"]
    }
  }
  statement {
    sid       = "Describe"
    actions   = ["ec2:DescribeVolumes", "ec2:DescribeInstances", "autoscaling:DescribeAutoScalingInstances"]
    resources = ["*"]
  }
  statement {
    sid       = "OwnLifecycle"
    actions   = ["autoscaling:CompleteLifecycleAction", "autoscaling:RecordLifecycleActionHeartbeat", "autoscaling:SetDesiredCapacity"]
    resources = [aws_autoscaling_group.host.arn]
  }
  statement {
    sid       = "CostRead"
    actions   = ["ce:GetCostAndUsage", "freetier:GetAccountPlanState"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "host" {
  name   = "host"
  role   = aws_iam_role.host.id
  policy = data.aws_iam_policy_document.host.json
}

resource "aws_iam_instance_profile" "host" {
  name = "${local.name}-host"
  role = aws_iam_role.host.name
}

# ---------------------------------------------------------------- guard lambda role
data "aws_iam_policy_document" "lambda_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "guard" {
  name                 = "${local.name}-guard"
  assume_role_policy   = data.aws_iam_policy_document.lambda_trust.json
  permissions_boundary = aws_iam_policy.boundary.arn
}

data "aws_iam_policy_document" "guard" {
  statement {
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:aws:logs:${var.region}:${local.account}:*"]
  }
  statement {
    actions   = ["freetier:GetAccountPlanState", "autoscaling:DescribeAutoScalingGroups"]
    resources = ["*"]
  }
  statement {
    actions   = ["autoscaling:UpdateAutoScalingGroup", "autoscaling:SetDesiredCapacity", "autoscaling:SuspendProcesses"]
    resources = [aws_autoscaling_group.host.arn]
  }
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["arn:aws:secretsmanager:${var.region}:${local.account}:secret:agentcraft/discord*"]
  }
}

resource "aws_iam_role_policy" "guard" {
  name   = "guard"
  role   = aws_iam_role.guard.id
  policy = data.aws_iam_policy_document.guard.json
}

# EventBridge Scheduler -> Lambda
data "aws_iam_policy_document" "scheduler_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name                 = "${local.name}-scheduler"
  assume_role_policy   = data.aws_iam_policy_document.scheduler_trust.json
  permissions_boundary = aws_iam_policy.boundary.arn
}

resource "aws_iam_role_policy" "scheduler" {
  name = "invoke-guard"
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "lambda:InvokeFunction", Resource = aws_lambda_function.guard.arn }]
  })
}
