data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_launch_template" "host" {
  name_prefix   = "${local.name}-"
  image_id      = data.aws_ssm_parameter.al2023.value
  instance_type = var.instance_types[0]
  iam_instance_profile { arn = aws_iam_instance_profile.host.arn }
  vpc_security_group_ids = [aws_security_group.host.id]

  metadata_options {
    http_tokens                 = "required" # IMDSv2 only
    http_put_response_hop_limit = 2          # containers need the instance role for Bedrock/Secrets
    instance_metadata_tags      = "enabled"
  }

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = 20
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }

  user_data = base64encode(templatefile("${path.module}/user-data.sh", {
    region         = var.region
    world_volume   = aws_ebs_volume.world.id
    data_bucket    = aws_s3_bucket.data.bucket
    asg_name       = "${local.name}-host"
    lifecycle_hook = "${local.name}-drain"
  }))

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${local.name}-host", project = "agentcraft" }
  }
  tag_specifications {
    resource_type = "volume"
    tags          = { Name = "${local.name}-root", project = "agentcraft" }
  }
}

resource "aws_autoscaling_group" "host" {
  name                = "${local.name}-host"
  min_size            = 0
  max_size            = 1
  desired_capacity    = 0
  vpc_zone_identifier = [aws_subnet.public.id]
  health_check_type   = "EC2"
  capacity_rebalance  = false

  mixed_instances_policy {
    instances_distribution {
      on_demand_base_capacity                  = 0
      on_demand_percentage_above_base_capacity = 0
      spot_allocation_strategy                 = "price-capacity-optimized"
    }
    launch_template {
      launch_template_specification {
        launch_template_id = aws_launch_template.host.id
        version            = "$Latest"
      }
      dynamic "override" {
        for_each = var.instance_types
        content { instance_type = override.value }
      }
    }
  }

  # Give the host time to save the world and back up before it disappears.
  initial_lifecycle_hook {
    name                 = "${local.name}-drain"
    lifecycle_transition = "autoscaling:EC2_INSTANCE_TERMINATING"
    heartbeat_timeout    = 900
    default_result       = "CONTINUE"
  }

  tag {
    key                 = "project"
    value               = "agentcraft"
    propagate_at_launch = true
  }

  lifecycle { ignore_changes = [desired_capacity] }
}

resource "aws_autoscaling_schedule" "wake" {
  scheduled_action_name  = "season-start"
  autoscaling_group_name = aws_autoscaling_group.host.name
  recurrence             = var.scale_out_cron
  time_zone              = var.season_timezone
  min_size               = 0
  max_size               = 1
  desired_capacity       = 1
}

resource "aws_autoscaling_schedule" "sleep" {
  scheduled_action_name  = "season-end"
  autoscaling_group_name = aws_autoscaling_group.host.name
  recurrence             = var.scale_in_cron
  time_zone              = var.season_timezone
  min_size               = 0
  max_size               = 1
  desired_capacity       = 0
}
