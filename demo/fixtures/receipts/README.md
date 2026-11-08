# Fixture receipts

Built by `pnpm export-receipts` from the fixture:dev fixture set through the worker's own request
builder and the receipt library. Each `<name>.receipt.json` has its exact bytes beside it
(`.request.bin`, `.response.bin`, `.report.bin`).

```bash
pnpm verify-receipt demo/fixtures/receipts/01-northwind-invoice.wrong-total.receipt.json
```

These are **dev** fixtures: signed by the repo's throwaway test key, with no TEE behind them. Their receipts say so in `attestation.verifier`. Genuine NEAR AI Cloud fixtures replace them once recorded with `pnpm record-fixtures --live`.
