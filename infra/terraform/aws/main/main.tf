terraform {
  required_version = ">= 1.10"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 6.68" }
    archive = { source = "hashicorp/archive", version = "~> 2.8" }
    random  = { source = "hashicorp/random", version = "~> 3.9" }
  }
  backend "s3" {
    bucket       = "agentcraft-tfstate-409178193669"
    key          = "main/terraform.tfstate"
    region       = "eu-north-1"
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = var.region
  default_tags { tags = { project = "agentcraft" } }
}

data "aws_caller_identity" "me" {}

locals {
  account = data.aws_caller_identity.me.account_id
  name    = "agentcraft"
}
