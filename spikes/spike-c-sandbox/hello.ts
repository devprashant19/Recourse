/**
 * Spike C — pick the sandbox tooling for the TypeScript demo runner.
 *
 *   pnpm spike:c
 *
 * The question: does `near-workspaces` (JS) still work well enough to drive
 * `pnpm demo`, or do we fall back to `near-sandbox` + `near-api-js`, or drive the
 * demo from Rust `near-workspaces`?
 *
 * Decide by DOING, not by reading: boot a sandbox, deploy a hello-world contract,
 * call it, and — the part that actually matters — call `fast_forward`. The demo
 * skips a 72 h claim window and a 48 h appeal window, so time travel is not
 * optional.
 *
 * Spec: phases/phase-00-setup-and-spikes.md section 5.
 */

async function main() {
  console.log("Spike C — sandbox tooling check\n");

  let Worker: typeof import("near-workspaces").Worker;
  try {
    ({ Worker } = await import("near-workspaces"));
  } catch {
    console.error("near-workspaces is not installed.");
    console.error("  pnpm add -D near-workspaces");
    console.error("\nIf it will not install or is stale, take the fallback:");
    console.error("  near-sandbox + near-api-js, or drive the demo from Rust near-workspaces.");
    process.exit(1);
  }

  const worker = await Worker.init();
  const root = worker.rootAccount;

  try {
    console.log("sandbox booted");

    // 1. Deploy anything at all.
    const contract = await root.devDeploy("spikes/spike-c-sandbox/hello.wasm").catch(async () => {
      console.log("no hello.wasm — creating a bare account instead (deploy check skipped)");
      return root.createSubAccount("hello");
    });
    console.log(`account ready: ${contract.accountId}`);

    // 2. The check that decides the tooling: can we skip time?
    const before = (await worker.provider.block({ finality: "final" })).header.height;
    console.log(`block height before: ${before}`);

    await worker.provider.fastForward(1_000);

    const after = (await worker.provider.block({ finality: "final" })).header.height;
    console.log(`block height after:  ${after}`);

    if (after <= before) {
      console.error("\nfast_forward did not advance the chain.");
      console.error("FALLBACK: near-sandbox + near-api-js, or Rust near-workspaces.");
      console.error("\nSPIKE C: FAIL");
      process.exit(1);
    }

    console.log(`\nfast_forward advanced ${after - before} blocks`);
    console.log("DECISION: near-workspaces (JS) can drive pnpm demo.");
    console.log("\nSPIKE C: PASS");
  } finally {
    await worker.tearDown().catch(() => {});
  }
}

main().catch((e) => {
  console.error("SPIKE C: FAIL");
  console.error(e);
  console.error("\nFALLBACK: near-sandbox + near-api-js, or drive the demo from Rust near-workspaces.");
  process.exit(1);
});
