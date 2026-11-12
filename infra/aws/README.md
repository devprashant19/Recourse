# Recourse on AWS

Terraform for the keyless sandbox demo: one x86_64 EC2 instance running the
shipped `docker compose` stack, Caddy in front for automatic TLS, and daily EBS
snapshots.

## Why this shape

Two properties of the codebase decide the architecture, so changing them is a
code change, not a configuration one.

**x86_64 is mandatory.** [`scripts/lib/sandbox.ts`](../../scripts/lib/sandbox.ts)
resolves the NEAR sandbox binary to `Linux-x86_64` or `Darwin-arm64` and throws
on anything else. Graviton (`t4g`, `m7g`, `c7g`, arm64 Fargate) cannot run this,
which also rules out the free ARM tiers that look generous on paper. The
`instance_type` variable rejects Graviton types rather than letting you find out
after a 30-minute boot.

**The database is SQLite, not RDS.** The indexer stores events, the hash-linked
`audit_chain`, explanations, anchors and the notification outbox in a single
SQLite file ([`services/indexer/src/db.ts`](../../services/indexer/src/db.ts));
`better-sqlite3` is the only database driver in the repository. So:

- the file lives on the instance's gp3 root volume, snapshotted daily;
- **do not** put it on EFS — SQLite over NFS is corruption-prone, which is what
  rules out the usual Fargate + EFS shape;
- **never run more than one indexer.** SQLite wants a single writer.

The sandbox is also a long-lived stateful process that resets hourly, so one
instance running compose is the design, not a shortcut.

## Prerequisites

- Terraform >= 1.6 and AWS credentials with EC2/IAM/DLM permissions.
- A public Git URL for this repository (`repo_url`) — the instance clones it.
- Optional: a domain you control, for HTTPS.

## Deploy

```bash
cd infra/aws
cp terraform.tfvars.example terraform.tfvars   # then edit it
terraform init
terraform plan                                  # read this before applying
terraform apply
```

`terraform apply` prints the Elastic IP. **Point your domain's A record at it as
soon as you see it** — Caddy retries the certificate until the record resolves,
so a few minutes of 502 at the start is expected, not a failure.

First boot compiles the Rust contract inside the image, which takes **20-30
minutes**. Follow it:

```bash
aws ssm start-session --target <instance_id>     # no SSH port needed
sudo tail -f /var/log/recourse-bootstrap.log
```

## Verify

```bash
curl -fsS https://<domain>/api/health            # indexer
curl -fsS https://<domain>/api/demo/run | jq '.status.passed, .status.solvency_ok'
```

Expect `7` and `true` once the first seed finishes (about 6-7 minutes after the
stack starts). The site itself is at `https://<domain>`.

## What it costs

The instance dominates. `m7i-flex.xlarge` on-demand in `us-east-1` is roughly
$70-130/month depending on type and region, plus about $5 for 80 GB gp3 and a
few cents for snapshots. No ALB and no NAT gateway, so nothing else recurring.
Check the current AWS calculator — these are ballpark figures, not quotes.

A plain x86 VM elsewhere (for example Hetzner CPX31, ~EUR 9/month) does the same
job far cheaper. Choose AWS for credits, an existing account, or a requirement
to be on AWS, not because it suits this workload better.

## Security notes

- Only 80 and 443 are open. Ports 3000 (site) and 8080 (API) are bound on the
  host for Caddy to proxy over localhost, and are not in the security group.
- **Port 3030, the NEAR sandbox RPC, is never published.** It is an
  unauthenticated node RPC. Do not add a rule for it.
- SSH is closed by default. The instance carries an SSM role; set `ssh_cidr` to
  your own `/32` only if you specifically want port 22.
- IMDSv2 is required, and the root volume is encrypted.
- The demo endpoints are already rate-limited (10 actions per minute per IP) and
  act through a server-side demo client, so visitors never need a wallet.
- `user-data.sh` fetches Caddy — and, if the distro package is missing, the
  compose plugin — from pinned GitHub releases. Verify those checksums against
  the release pages if your threat model calls for it.

## Updating a running deployment

```bash
aws ssm start-session --target <instance_id>
cd /opt/recourse && sudo git pull && sudo systemctl restart recourse
```

Changing `repo_ref`, `domain` or `reset_minutes` in tfvars and re-applying
replaces the instance (`user_data_replace_on_change = true`), which rebuilds
from scratch and loses the SQLite file. For a code update prefer the git pull
above; the Elastic IP survives either way.

## Tear down

```bash
terraform destroy
```

Snapshots created by the lifecycle policy are **not** deleted with the stack.
Remove them yourself if you do not want to keep paying for them.

## What this does not cover

Live testnet mode (`docker compose --profile testnet up`) needs owner, agent,
arbiter, keeper and underwriter keys and a deployed contract. See
[`docs/hosting.md`](../../docs/hosting.md). This Terraform deploys the keyless
sandbox demo only.
