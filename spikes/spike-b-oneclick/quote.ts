/**
 * Spike B — one 1Click dry-run quote, USDC on NEAR to USDC on Base.
 *
 *   pnpm spike:b
 *
 * Proves the cross-chain payout leg is reachable, and prints the asset IDs the
 * keeper will need. ONECLICK_JWT is optional but avoids the 0.25% unauthenticated
 * fee — set it once the partner dashboard issues one.
 *
 * Asset IDs are looked up by symbol and chain and printed for the README. They are
 * NEVER hard-coded: the keeper reads GET /v0/tokens at startup.
 *
 * Spec: phases/phase-00-setup-and-spikes.md section 4.
 */

const BASE = process.env.ONECLICK_BASE_URL ?? "https://1click.chaindefuser.com";
const JWT = process.env.ONECLICK_JWT;

type Token = {
  assetId: string;
  symbol: string;
  blockchain: string;
  decimals: number;
};

const authHeaders = (): Record<string, string> =>
  JWT ? { Authorization: `Bearer ${JWT}` } : {};

function findToken(tokens: Token[], symbol: string, chain: string): Token {
  const hits = tokens.filter(
    (t) =>
      t.symbol.toUpperCase() === symbol.toUpperCase() &&
      t.blockchain.toLowerCase() === chain.toLowerCase(),
  );
  if (hits.length === 0) {
    throw new Error(
      `no ${symbol} on ${chain} in /v0/tokens — check the chain spelling against the live list`,
    );
  }
  if (hits.length > 1) {
    console.warn(`  warning: ${hits.length} matches for ${symbol} on ${chain}; using the first`);
    for (const h of hits) console.warn(`    ${h.assetId}`);
  }
  return hits[0]!;
}

async function main() {
  if (!JWT) {
    console.warn("ONECLICK_JWT not set — quoting unauthenticated (0.25% fee applies).\n");
  }

  // 1. Asset IDs, by symbol and chain.
  const tokensRes = await fetch(`${BASE}/v0/tokens`, { headers: authHeaders() });
  if (!tokensRes.ok) throw new Error(`GET /v0/tokens failed: ${tokensRes.status}`);
  const tokens = (await tokensRes.json()) as Token[];

  console.log(`/v0/tokens returned ${tokens.length} assets\n`);

  const originAsset = findToken(tokens, "USDC", "near");
  const destinationAsset = findToken(tokens, "USDC", "base");

  // Put these two lines in the README.
  console.log("ASSET IDS (for the README):");
  console.log(`  USDC on NEAR   ${originAsset.assetId}   (${originAsset.decimals} decimals)`);
  console.log(`  USDC on Base   ${destinationAsset.assetId}   (${destinationAsset.decimals} decimals)\n`);

  // 2. A dry quote for ~$1.
  const amount = (10n ** BigInt(originAsset.decimals)).toString();
  const body = {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: originAsset.assetId,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: destinationAsset.assetId,
    amount,
    // On the real path these are the contract and the claimant's fixed destination.
    refundTo: process.env.RECOURSE_CONTRACT_ID ?? "recourse-demo.near",
    refundType: "ORIGIN_CHAIN",
    recipient: process.env.SPIKE_B_RECIPIENT ?? "0x0000000000000000000000000000000000000001",
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  };

  const quoteRes = await fetch(`${BASE}/v0/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });

  const quoteText = await quoteRes.text();
  if (!quoteRes.ok) {
    console.error(`POST /v0/quote failed: ${quoteRes.status}`);
    console.error(quoteText);
    console.error("\nSPIKE B: FAIL");
    process.exit(1);
  }

  const quote = JSON.parse(quoteText);
  console.log("QUOTE:");
  console.log(JSON.stringify(quote, null, 2).slice(0, 2000));

  console.log("\nWhat to confirm:");
  console.log("  * amountOut is roughly the amountIn minus fees (a USDC-to-USDC route)");
  console.log("  * a depositAddress is present (it will be absent on a dry quote)");
  console.log("  * the recipient echoed back is the one we sent — the keeper cannot redirect (T8)");
  console.log("\nAlso try `confidentiality: \"basic\"` on this route in Phase 3; keep it if accepted,");
  console.log("and note the outcome in the README either way.");
  console.log("\nSPIKE B: PASS");
}

main().catch((e) => {
  console.error("SPIKE B: FAIL");
  console.error(e);
  process.exit(1);
});

// Mark this file as a module so each spike gets its own scope.
export {};
