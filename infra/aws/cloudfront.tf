# Optional CloudFront distribution: gives a free https://<id>.cloudfront.net
# address with a valid certificate, with no domain to buy. Off by default.
#
#   cloudfront = true   in terraform.tfvars
#
# Why this is not just a CDN here: the point is the certificate. CloudFront's
# default *.cloudfront.net name comes with AWS's own cert, and Let's Encrypt
# will not issue for the free ec2-*.compute.amazonaws.com name, so this is the
# only way to get HTTPS without registering a domain.

variable "cloudfront" {
  description = "Put CloudFront in front of the instance for a free HTTPS address."
  type        = bool
  default     = false
}

# Looked up by name rather than hardcoded as UUIDs, which is what most examples
# do and what breaks when AWS changes them.
data "aws_cloudfront_cache_policy" "disabled" {
  count = var.cloudfront ? 1 : 0
  name  = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  count = var.cloudfront ? 1 : 0
  name  = "Managed-AllViewerExceptHostHeader"
}

resource "aws_cloudfront_distribution" "cdn" {
  count       = var.cloudfront ? 1 : 0
  enabled     = true
  comment     = "${var.name} hosted demo"
  price_class = "PriceClass_100"

  origin {
    # The EIP's own public DNS name. Caddy answers any Host on :80, so the
    # header CloudFront sends does not need a matching site block.
    domain_name = aws_eip.app.public_dns
    origin_id   = "ec2"

    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = "http-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 60
      origin_keepalive_timeout = 5
    }
  }

  default_cache_behavior {
    target_origin_id       = "ec2"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    # Every method, because the demo endpoints POST. CloudFront's default
    # allows only GET and HEAD, which would silently break the reset button.
    allowed_methods = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods  = ["GET", "HEAD"]

    # Caching is DISABLED on purpose. This is a live demo whose whole point is
    # that the numbers are current: a cached /api/demo/run would show a judge a
    # stale 6/7 from before a reseed. The origin-request policy forwards every
    # header, cookie and query string except Host, so nothing behaves
    # differently through the CDN than it does direct.
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled[0].id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host[0].id
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  tags = local.common_tags
}

output "cloudfront_url" {
  description = "Free HTTPS address, if cloudfront = true."
  value       = var.cloudfront ? "https://${aws_cloudfront_distribution.cdn[0].domain_name}" : "(cloudfront = false)"
}
