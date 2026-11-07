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
 * ---------------------------------------------------------------------------
 * FINDING (7 Nov 2026, Phase 0): near-workspaces is NOT installable on Windows.
 *
 * near-workspaces@4 pulls near-sandbox@0.1.5, whose postinstall downloads a
 * nearcore binary and hard-fails with "Unsupported platform: Windows_NT x64".
 * It publishes Linux x64 and Darwin arm64 only.
 *
 * Consequences, and they matter beyond this spike:
 *   * Develop and run `pnpm demo` under WSL2, Linux, macOS, or Docker.
 *   * CI runs on ubuntu-latest, so it is unaffected.
 *   * A judge on bare Windows cannot run `pnpm demo`. The README must say so and
 *     point at Docker, or the demo must ship as a container. This is a real risk
 *     to the "fresh clone, no keys, 3 minutes" promise — do not discover it on
 *     14 Nov.
 *
 * near-workspaces is therefore NOT a root dependency. Install it in the
 * environment where the demo actually runs:
 *     pnpm add -D near-workspaces
 * ---------------------------------------------------------------------------
 */

/** Structural shape of the bits of near-workspaces this spike touches. */
type SandboxWorker = {
  rootAccount: {
    accountId: string;
    devDeploy(wasm: string): Promise<{ accountId: string }>;
    createSubAccount(name: string): Promise<{ accountId: string }>;
  };
  provider: {
    block(opts: { finality: string }): Promise<{ header: { height: number } }>;
    fastForward(blocks: number): Promise<void>;
  };
  tearDown(): Promise<void>;
};

async function loadWorkspaces(): Promise<{ init(): Promise<SandboxWorker> }> {
  // Indirect specifier: this spike must typecheck on machines where
  // near-workspaces is not (and cannot be) installed.
  const specifier = "near-workspaces";
  const mod = (await import(specifier)) as { Worker: { init(): Promise<SandboxWorker> } };
  return mod.Worker;
}

async function main() {
  console.log("Spike C — sandbox tooling check\n");

  if (process.platform === "win32") {
    console.error("Windows detected. near-sandbox has no Windows binary, so this");
    console.error("spike cannot run here. Use WSL2, Linux, macOS or Docker.");
    console.error("See the FINDING block at the top of this file.");
    process.exit(1);
  }

  let Worker: { init(): Promise<SandboxWorker> };
  try {
    Worker = await loadWorkspaces();
  } catch {
    console.error("near-workspaces is not installed.");
    console.error("  pnpm add -D near-workspaces");
    console.error("\nIf it will not install or is stale, take the fallback:");
    console.error("  near-sandbox + near-api-js, or drive the demo from Rust near-workspaces.");
    process.exit(1);
  }

  const worker = await Worker.init();

  try {
    console.log("sandbox booted");

    // 1. Deploy anything at all.
    const account = await worker.rootAccount
      .devDeploy("spikes/spike-c-sandbox/hello.wasm")
      .catch(async () => {
        console.log("no hello.wasm — creating a bare account instead (deploy check skipped)");
        return worker.rootAccount.createSubAccount("hello");
      });
    console.log(`account ready: ${account.accountId}`);

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
    console.log("DECISION: near-workspaces (JS) can drive pnpm demo — on Linux/macOS.");
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

// Mark this file as a module so each spike gets its own scope.
export {};
