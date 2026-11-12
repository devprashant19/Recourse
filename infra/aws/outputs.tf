output "public_ip" {
  description = "Elastic IP — point your A record here."
  value       = aws_eip.app.public_ip
}

output "instance_id" {
  description = "For `aws ssm start-session --target <id>`."
  value       = aws_instance.app.id
}

output "site_url" {
  value = var.domain == "" ? "http://${aws_eip.app.public_ip}" : "https://${var.domain}"
}

output "api_url" {
  description = "The indexer, proxied under /api. Health check: <api_url>/health"
  value       = var.domain == "" ? "http://${aws_eip.app.public_ip}/api" : "https://${var.domain}/api"
}

output "shell" {
  description = "Open a shell without any inbound port."
  value       = "aws ssm start-session --target ${aws_instance.app.id} --region ${var.region}"
}

output "first_boot_note" {
  value = "First boot compiles the Rust contract inside the image (~20-30 min). Follow it with: sudo tail -f /var/log/recourse-bootstrap.log"
}
