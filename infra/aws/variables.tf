variable "region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "us-east-1"
}

variable "name" {
  description = "Name prefix for every resource."
  type        = string
  default     = "recourse"
}

variable "instance_type" {
  description = <<-DESC
    Must be an x86_64 type — Graviton (t4g, m7g, c7g, and arm64 Fargate) cannot
    run the NEAR sandbox binary.

    Avoid burstable types (t3/t3a). The hourly reseed is a sustained ~6-minute
    burst across the sandbox, indexer, keeper, worker, arbiter and three
    underwriters; throttling there is the CPU contention that makes
    sandbox_fast_forward time out and scenarios fail.
  DESC
  type        = string
  default     = "m7i-flex.xlarge"

  validation {
    condition     = !can(regex("^[a-z]+[0-9]+g[a-z]*[.]", var.instance_type))
    error_message = "Graviton (arm64) instance types cannot run the NEAR sandbox: it ships only Linux-x86_64. Use an Intel/AMD type such as m7i-flex.xlarge or c7i.xlarge."
  }
}

variable "disk_gb" {
  description = <<-DESC
    Root gp3 volume size. The image is ~3 GB and building it compiles the Rust
    contract, which needs room for the cargo target directory; the SQLite store
    and logs live here too.
  DESC
  type        = number
  default     = 80

  validation {
    condition     = var.disk_gb >= 40
    error_message = "Give it at least 40 GB: the image build alone needs room for a full Rust target directory."
  }
}

variable "repo_url" {
  description = "Git URL the instance clones, e.g. https://github.com/<you>/Recourse.git"
  type        = string
}

variable "repo_ref" {
  description = "Branch, tag or commit to deploy."
  type        = string
  default     = "main"
}

variable "domain" {
  description = <<-DESC
    Domain for automatic HTTPS, e.g. demo.example.com. Point an A record at the
    Elastic IP this stack outputs BEFORE applying, or Caddy's certificate
    request will fail and it will retry.

    Leave empty to serve plain HTTP on the public IP (fine for a quick test,
    no TLS).
  DESC
  type        = string
  default     = ""
}

variable "ssh_cidr" {
  description = <<-DESC
    CIDR allowed to reach port 22, e.g. "203.0.113.4/32". Empty (the default)
    leaves SSH closed entirely — the instance gets an SSM role, so use
    `aws ssm start-session` instead of opening a port.
  DESC
  type        = string
  default     = ""
}

variable "key_name" {
  description = "Optional EC2 key pair name. Not needed when connecting over SSM."
  type        = string
  default     = ""
}

variable "reset_minutes" {
  description = "How often the hosted sandbox resets and reseeds (HOSTED_RESET_MINUTES)."
  type        = number
  default     = 60
}

variable "snapshot_retention" {
  description = <<-DESC
    Daily EBS snapshots to keep. The indexer's audit_chain is a hash-linked
    chain, so losing rows breaks its verifiable continuity — keep real backups.
  DESC
  type        = number
  default     = 7
}

variable "tags" {
  description = "Extra tags applied to every resource."
  type        = map(string)
  default     = {}
}
