# @recourse/intents

A small typed client for the NEAR Intents **1Click** Swap API (v0): `tokens()`,
`quote()` (keeps the exact response bytes and their sha256, which the
contract records as `quote_hash`), `submitDeposit()`, `status()`. Helpers:
`resolveUsdc()` (asset ids from `/v0/tokens`, never hard-coded),
`payoutQuoteRequest()` (the spec's payout quote), `checkQuote()` (rejects a
quote that does not echo the request, has no NEAR deposit address, needs a
memo, expires within 5 minutes, or pays out below a floor) and
`quoteWithConfidentialityFallback()`.

Auth: the partner JWT is sent as `X-API-Key` (the documented primary scheme).
Without it 1Click adds 0.25% to every quote, so live payouts need it.

## Observed on 2026-11-08 (dry quotes, no JWT, no funds)

- `/v0/tokens`: USDC on NEAR is
  `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`,
  USDC on Base is `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near`
  (both 6 decimals). The keeper still resolves them at startup.
- Dry quote, 1 USDC NEAR → Base: `amountOut` 997398, `minAmountOut` 987424
  (1% slippage), estimate 22 s; passes `checkQuote`.
- `confidentiality: "basic"` without a JWT: HTTP 401 "User authentication is
  required for confidential intent quotes". The fallback retries as a public
  quote; whether `basic` is accepted **with** a JWT is untested (no JWT here).
- A `refundTo` account that does not exist yet (`recourse-demo.near` before
  deployment) gets HTTP 400 "Internal server error"; an existing account works.
- A burn address (`0x…dEaD`) as recipient gets HTTP 400 "recipient is not valid".

Quotes carry 1Click's `signature` over the quote (base58 sha256 of the
stable-stringified request + response); it is kept with the raw quote so a
verifier can check it with 1Click's published key.
