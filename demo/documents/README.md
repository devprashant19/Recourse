# demo/documents

Five **fictional** invoices for the demo's structured-extraction job, each with its ground truth beside
it. Every company, person, address and number is invented.

| File | Layout | Notes |
|---|---|---|
| [`01-northwind-invoice.md`](01-northwind-invoice.md) | Markdown tables | Has a PO number |
| [`02-quillfeather-invoice.md`](02-quillfeather-invoice.md) | Dotted plain text, long-form dates | **No PO** — a hallucinated PO is unambiguously wrong |
| [`03-tidewater-invoice.md`](03-tidewater-invoice.md) | Statement with bullet usage lines | 0% tax (reverse charge) |
| [`04-amberline-invoice.md`](04-amberline-invoice.md) | Fixed-width freight invoice | Thousands separators; "Net 45" terms |
| [`05-lumen-invoice.md`](05-lumen-invoice.md) | Prose letter | **No PO**; figures embedded in sentences |

- `schema.json` — the JSON Schema the agent must fill (`additionalProperties: false`; amounts are
  two-decimal strings, dates ISO-8601, `po_number` is `null` when the document has none).
- `weights.json` — each field's weight in basis points (sums to 10 000). The arbiter's award is
  `liability_cap × Σ weights of wrong fields`, capped at the claimed amount. `total` carries the most
  weight, so the `wrong_total` sabotage costs 30% of the cap.
- `*.truth.json` — the correct extraction for each document, valid against `schema.json`.

A job's terms (`@recourse/jobs`) commit to the document's SHA-256, the schema's SHA-256 and the weights;
the on-chain `terms_hash` is the SHA-256 of their RFC 8785 canonical JSON, so the worker can check it
was given the right document before working.
