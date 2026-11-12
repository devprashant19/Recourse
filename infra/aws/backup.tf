# Daily snapshots of the root volume, which holds the indexer's SQLite file.
#
# This is not boilerplate: audit_chain in services/indexer/src/db.ts is a
# hash-linked chain (each record commits to the previous hash), so rows lost to
# a dead instance do not just lose data, they break the continuity the audit
# endpoint is there to prove.
data "aws_iam_policy_document" "assume_dlm" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["dlm.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "dlm" {
  name               = "${var.name}-dlm"
  assume_role_policy = data.aws_iam_policy_document.assume_dlm.json
  tags               = local.common_tags
}

resource "aws_iam_role_policy_attachment" "dlm" {
  role       = aws_iam_role.dlm.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

resource "aws_dlm_lifecycle_policy" "daily" {
  # DLM descriptions accept only [0-9A-Za-z _-] — no colons, no punctuation.
  description        = "${var.name} daily snapshot of the SQLite store"
  execution_role_arn = aws_iam_role.dlm.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]
    target_tags    = { Backup = "daily" }

    schedule {
      name = "daily"
      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = ["03:00"]
      }
      retain_rule {
        count = var.snapshot_retention
      }
      copy_tags = true
    }
  }

  tags = local.common_tags
}
