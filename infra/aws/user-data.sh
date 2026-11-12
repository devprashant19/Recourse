#!/bin/bash
# Recourse first-boot bootstrap (Amazon Linux 2023, x86_64).
# Rendered by Terraform's templatefile(). A single dollar-brace token is a
# Terraform value; a doubled one escapes through to the shell.
set -euxo pipefail
exec > >(tee -a /var/log/recourse-bootstrap.log) 2>&1

echo "=== recourse bootstrap $(date -Is) ==="

dnf -y update
dnf -y install docker git tar

# Prefer the distro's compose plugin; fall back to the upstream release.
if ! dnf -y install docker-compose-plugin; then
  echo "docker-compose-plugin not in repos; fetching the pinned upstream build"
  COMPOSE_VERSION=v2.29.7
  install -d /usr/libexec/docker/cli-plugins
  curl -fsSL -o /usr/libexec/docker/cli-plugins/docker-compose \
    "https://github.com/docker/compose/releases/download/$COMPOSE_VERSION/docker-compose-linux-x86_64"
  chmod +x /usr/libexec/docker/cli-plugins/docker-compose
fi

systemctl enable --now docker
usermod -aG docker ec2-user || true

docker --version
docker compose version

# ---- the application -------------------------------------------------------
install -d /opt
if [ ! -d /opt/recourse/.git ]; then
  git clone "${repo_url}" /opt/recourse
fi
cd /opt/recourse
git fetch --all --tags --prune
git checkout "${repo_ref}"
git pull --ff-only || true

# NEXT_PUBLIC_API_URL is inlined into the browser bundle when the web container
# runs `next build` at start, so it has to be right BEFORE the stack comes up.
# Left at its localhost default, every visitor's browser would call their own
# machine. Caddy serves the indexer under /api on the same origin, which also
# means there is no CORS configuration to get wrong.
DOMAIN="${domain}"
if [ -n "$DOMAIN" ]; then
  PUBLIC_BASE="https://$DOMAIN"
else
  TOKEN=$(curl -fsS -X PUT "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
  IP=$(curl -fsS -H "X-aws-ec2-metadata-token: $TOKEN" \
    "http://169.254.169.254/latest/meta-data/public-ipv4")
  PUBLIC_BASE="http://$IP"
fi

cat > /opt/recourse/.env <<ENVFILE
HOSTED_RESET_MINUTES=${reset_minutes}
HOSTED_SEED=1
PUBLIC_API_URL=$PUBLIC_BASE/api
ENVFILE
chmod 600 /opt/recourse/.env

# ---- reverse proxy ---------------------------------------------------------
# Static binary: Caddy publishes no Amazon Linux 2023 package. Pinned on
# purpose - bump it deliberately and check the checksum on the release page.
CADDY_VERSION=2.8.4
if ! command -v caddy >/dev/null 2>&1; then
  install -d /tmp/caddy-dl
  curl -fsSL -o /tmp/caddy-dl/caddy.tar.gz \
    "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/caddy_$${CADDY_VERSION}_linux_amd64.tar.gz"
  tar -xzf /tmp/caddy-dl/caddy.tar.gz -C /tmp/caddy-dl caddy
  install -m 0755 /tmp/caddy-dl/caddy /usr/local/bin/caddy
fi
useradd --system --home /var/lib/caddy --create-home --shell /usr/sbin/nologin caddy || true
install -d -o caddy -g caddy /var/lib/caddy /etc/caddy

# handle_path strips /api before proxying, so the indexer keeps serving
# /health, /claims and /vaults at its own root.
if [ -n "$DOMAIN" ]; then
  SITE="$DOMAIN"
else
  SITE=":80"
  echo "WARNING: no domain set - serving plain HTTP, no TLS"
fi
cat > /etc/caddy/Caddyfile <<CADDYFILE
$SITE {
	encode zstd gzip

	handle_path /api/* {
		reverse_proxy 127.0.0.1:8080
	}

	reverse_proxy 127.0.0.1:3000
}
CADDYFILE

cat > /etc/systemd/system/caddy.service <<'CADDYUNIT'
[Unit]
Description=Caddy
After=network.target

[Service]
User=caddy
Group=caddy
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
Restart=on-failure
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
CADDYUNIT

# ---- the stack as a service ------------------------------------------------
# compose already carries `restart: unless-stopped` on every service; this unit
# is what brings the stack back after a reboot or an explicit stop/start.
cat > /etc/systemd/system/recourse.service <<'APPUNIT'
[Unit]
Description=Recourse hosted sandbox stack
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/recourse
ExecStart=/usr/bin/docker compose up -d --build
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=3600

[Install]
WantedBy=multi-user.target
APPUNIT

systemctl daemon-reload
systemctl enable --now caddy
# The first run compiles the Rust contract inside the image: 20-30 minutes.
systemctl enable --now recourse

echo "=== bootstrap finished $(date -Is); site $PUBLIC_BASE ==="
