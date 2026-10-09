variable "region" {
  type    = string
  default = "eu-north-1"
}

variable "az" {
  description = "Single AZ: the world volume and the instance must share it."
  type        = string
  default     = "eu-north-1a"
}

variable "instance_types" {
  description = "Spot candidates (Graviton, 8+ GiB). Diversity lowers interruption risk."
  type        = list(string)
  default     = ["t4g.large", "m7g.large", "m6g.large", "m8g.large", "c7g.xlarge", "r7g.large"]
}

variable "world_volume_gb" {
  type    = number
  default = 16
}

variable "season_timezone" {
  type    = string
  default = "Europe/London"
}

variable "scale_out_cron" {
  description = "Boot ~15 min before the 18:00 season start."
  type        = string
  default     = "45 17 * * *"
}

variable "scale_in_cron" {
  description = "After the 00:00 bedtime, the Chronicle and the final backup."
  type        = string
  default     = "50 0 * * *"
}

variable "hosting_budget_usd" {
  type    = number
  default = 20
}

variable "llm_budget_usd" {
  type    = number
  default = 80
}

variable "credit_floor_usd" {
  description = "Stop everything when remaining Free Tier credit falls below this."
  type        = number
  default     = 10
}

variable "backup_retention_days" {
  type    = number
  default = 14
}
