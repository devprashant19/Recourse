# tests/adversarial

One test per `THREAT_MODEL.md` entry (`t01` … `t16`), each attacking a live, seeded sandbox and
asserting the contract's named error (or that the attacker ends up poorer). The suite ends with
`solvency()`.

```bash
pnpm demo -- --keep          # leaves a deployed, seeded sandbox running
pnpm test:adversarial
```

`npm run judge` does both and prints one row per threat. With no sandbox, the suite skips.
