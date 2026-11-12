locals {
  common_tags = merge({ Project = "recourse", ManagedBy = "terraform" }, var.tags)
}

resource "aws_security_group" "web" {
  name        = "${var.name}-web"
  description = "Recourse: public HTTP/HTTPS only; app ports stay on localhost"
  vpc_id      = data.aws_vpc.default.id
  tags        = merge(local.common_tags, { Name = "${var.name}-web" })
}

# Caddy terminates TLS on 443 and redirects 80.
resource "aws_vpc_security_group_ingress_rule" "https" {
  security_group_id = aws_security_group.web.id
  description       = "HTTPS"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "http" {
  security_group_id = aws_security_group.web.id
  description       = "HTTP (ACME challenge and redirect to HTTPS)"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
}

# Opt-in only. Prefer `aws ssm start-session`, which needs no open port.
resource "aws_vpc_security_group_ingress_rule" "ssh" {
  count             = var.ssh_cidr == "" ? 0 : 1
  security_group_id = aws_security_group.web.id
  description       = "SSH from an explicit CIDR"
  cidr_ipv4         = var.ssh_cidr
  from_port         = 22
  to_port           = 22
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.web.id
  description       = "Outbound: package installs, git clone, NEAR RPC, 1Click"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

# NOTE: ports 3000 (site), 8080 (indexer API) and 3030 (NEAR sandbox RPC) are
# deliberately absent. compose binds 3000 and 8080 on the host for Caddy to
# proxy over localhost, and 3030 is never published at all. Do not add rules
# for them: 3030 is an unauthenticated node RPC.
