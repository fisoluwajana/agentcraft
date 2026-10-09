output "asg_name" { value = aws_autoscaling_group.host.name }
output "data_bucket" { value = aws_s3_bucket.data.bucket }
output "world_volume" { value = aws_ebs_volume.world.id }
output "guard_function" { value = aws_lambda_function.guard.function_name }
