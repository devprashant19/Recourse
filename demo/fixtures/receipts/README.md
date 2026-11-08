# Fixture receipts

Built by `pnpm export-receipts` from the fixture:genuine fixture set through the worker's own request
builder and the receipt library. Each `<name>.receipt.json` has its exact bytes beside it
(`.request.bin`, `.response.bin`, `.report.bin`).

```bash
pnpm verify-receipt demo/fixtures/receipts/01-northwind-invoice.wrong-total.receipt.json
```

These are genuine NEAR AI Cloud recordings.
