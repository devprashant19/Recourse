# Recourse on AWS — one x86_64 EC2 instance running the shipped docker compose
# stack, with Caddy in front for TLS and daily EBS snapshots of the SQLite store.
#
# Why one instance and not ECS/Fargate: the indexer's store is SQLite
# (services/indexer/src/db.ts), which wants a single writer on a real
# filesystem, and the NEAR sandbox is a long-lived stateful process that resets
# hourly. SQLite over EFS/NFS is corruption-prone, so the managed-container
# shape would be fighting the design.

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
}

provider "aws" {
  region = var.region
}

# Amazon Linux 2023, x86_64.
#
# The architecture is not a preference: scripts/lib/sandbox.ts publishes the
# NEAR sandbox binary only for Linux-x86_64 and Darwin-arm64, and throws on
# anything else. An arm64 AMI (or a Graviton instance type) cannot run this.
data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64"
}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}
