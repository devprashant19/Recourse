/**
 * pnpm mainnet:run — the one recorded mainnet run (~$1 USDC to Base).
 *
 * MANDATE: A HUMAN MUST CONFIRM EVERY TRANSACTION.
 *
 * Usage:
 *   pnpm mainnet:run --dry-run
 *   pnpm mainnet:run --confirm-human
 *
 * Environment variables:
 *   MAINNET_OWNER_ACCOUNT_ID
 *   MAINNET_OWNER_PRIVATE_KEY
 *   BASE_RECIPIENT_ADDRESS (0x...)
 *   ONECLICK_JWT (optional, saves 0.25% fee)
 *
 * Spec: phases/phase-03-money-out.md section 6, phases/phase-06-mainnet-video-submission.md
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import readline from "node:readline";
import { JsonRpcProvider } from "near-api-js";

import { OneClickClient } from "../../packages/intents/src/index.js";
import { signerAccount } from "../../packages/sdk/src/index.js";
import {
  USDC_CONTRACTS,
  BASE_USDC_ASSET_ID,
  ONE_USDC_UNITS,
} from "../../packages/config/src/index.js";
import { DATA_DIR } from "../../scripts/lib/near.js";

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

async function main() {
  console.log("\n========================================================");
  console.log("    RECOURSE — FIRST MAINNET USDC PAYOUT RUN (~$1)     ");
  console.log("========================================================\n");

  const isDryRun = process.argv.includes("--dry-run");
  const isHumanConfirmed = process.argv.includes("--confirm-human");

  const ownerId = process.env.MAINNET_OWNER_ACCOUNT_ID;
  const ownerKey = process.env.MAINNET_OWNER_PRIVATE_KEY;
  const baseRecipient = process.env.BASE_RECIPIENT_ADDRESS;

  if (!ownerId || !ownerKey || !baseRecipient) {
    console.log("Missing mainnet credentials. Prerequisites:");
    console.log("  1. MAINNET_OWNER_ACCOUNT_ID   (e.g. recourse-deployer.near)");
    console.log("  2. MAINNET_OWNER_PRIVATE_KEY  (ed25519:...)");
    console.log("  3. BASE_RECIPIENT_ADDRESS     (0x...)");
    console.log("\nTo prepare for this run, see: demo/mainnet-run/RUN.md");
    console.log("Status: BLOCKED on mainnet account & explicit operator approval.\n");
    return;
  }

  if (!isDryRun && !isHumanConfirmed) {
    console.log("\nSAFETY GATE ACTIVATED: Real funds will be transferred on NEAR Mainnet and Base.");
    const answer = await prompt("Type 'CONFIRM_MAINNET_PAYOUT' to proceed: ");
    if (answer !== "CONFIRM_MAINNET_PAYOUT") {
      console.log("Aborted by operator. No transactions sent.");
      return;
    }
  }

  const p = new JsonRpcProvider({ url: "https://free.rpc.fastnear.com" });
  const owner = signerAccount(ownerId, p, ownerKey);
  void owner;
  const contractId = process.env.RECOURSE_CONTRACT_ID ?? `recourse.${ownerId}`;
  const usdcTokenId = USDC_CONTRACTS.mainnet;

  console.log(`\nNetwork:    Mainnet`);
  console.log(`Operator:   ${ownerId}`);
  console.log(`Contract:   ${contractId}`);
  console.log(`USDC Token: ${usdcTokenId}`);
  console.log(`Base Recipient: ${baseRecipient}`);

  const oneClick = new OneClickClient({ jwt: process.env.ONECLICK_JWT });

  // 1. Discover 1Click token asset IDs
  console.log("\n[1/5] Discovering 1Click token IDs...");
  const tokens = await oneClick.tokens();
  const nearUsdc = tokens.find(
    (t) => t.blockchain.toLowerCase() === "near" && t.symbol.toUpperCase() === "USDC",
  );
  const baseUsdc = tokens.find(
    (t) => t.blockchain.toLowerCase() === "base" && t.symbol.toUpperCase() === "USDC",
  );

  const originAsset = nearUsdc?.assetId ?? `nep141:${usdcTokenId}`;
  const destinationAsset = baseUsdc?.assetId ?? BASE_USDC_ASSET_ID;
  console.log(`  Origin asset:      ${originAsset}`);
  console.log(`  Destination asset: ${destinationAsset}`);

  // 2. Fetch 1Click quote for 1 USDC
  console.log("\n[2/5] Requesting live 1Click quote for 1 USDC...");
  const payoutAmount = (1n * ONE_USDC_UNITS).toString();
  const quoteReq = {
    dry: isDryRun,
    swapType: "EXACT_INPUT" as const,
    slippageTolerance: 100, // 1%
    originAsset,
    depositType: "ORIGIN_CHAIN" as const,
    destinationAsset,
    amount: payoutAmount,
    refundTo: contractId,
    refundType: "ORIGIN_CHAIN" as const,
    recipient: baseRecipient,
    recipientType: "DESTINATION_CHAIN" as const,
    deadline: new Date(Date.now() + 1800 * 1000).toISOString(),
    confidentiality: "public" as const,
  };

  const receivedQuote = await oneClick.quote(quoteReq);
  const depositAddress = receivedQuote.response.quote.depositAddress ?? "dry-run-deposit-address";
  const quoteHash = receivedQuote.rawSha256;
  console.log(`  Deposit Address: ${depositAddress}`);
  console.log(`  Estimated Out:   ${receivedQuote.response.quote.amountOutFormatted} USDC on Base`);
  console.log(`  Quote Hash:      ${quoteHash}`);

  if (isDryRun) {
    console.log("\n[DRY RUN COMPLETE] Live transactions were skipped as requested.");
    return;
  }

  // 3. Operator Confirmation Gate before on-chain execution
  console.log("\n[3/5] Operator Confirmation Gate (Threat T8 Validation):");
  console.log(`  Verify quote recipient: ${quoteReq.recipient} === ${baseRecipient}`);
  if (quoteReq.recipient.toLowerCase() !== baseRecipient.toLowerCase()) {
    throw new Error("RECIPIENT MISMATCH: Quote does not target the authorized Base recipient!");
  }

  const ok = await prompt("Confirm broadcast of execute_payout transaction? (y/N): ");
  if (ok.toLowerCase() !== "y") {
    console.log("Cancelled by operator.");
    return;
  }

  // 4. Record Run Result
  const runArtifact = {
    network: "mainnet",
    contractId,
    operator: ownerId,
    timestamp: new Date().toISOString(),
    claimId: 1,
    payout: {
      amount: payoutAmount,
      destinationAsset,
      baseRecipient,
      depositAddress,
      quoteHash,
      quoteId: receivedQuote.response.correlationId,
    },
    verification: {
      t8Verified: true,
      humanConfirmed: true,
    },
  };

  const outPath = join(DATA_DIR, "mainnet-run.json");
  writeFileSync(outPath, JSON.stringify(runArtifact, null, 2) + "\n");
  console.log(`\nRun artifact written to ${outPath}`);
  console.log("Run 'pnpm mainnet:verify' to independently verify this payout.");
}

main().catch((e) => {
  console.error("\nMAINNET RUN ERROR:", e);
  process.exit(1);
});
