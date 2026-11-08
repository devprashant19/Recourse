/**
 * Underwriter entry point: one persona, one vault.
 *
 *   UNDERWRITER_PERSONA=balanced pnpm --filter @recourse/underwriters start -- --mode sandbox
 */

import { Bidder } from "./bidder.js";
import { loadConfig } from "./config.js";
import { jsonLogger } from "./log.js";
import { PERSONAS, personaStrategy } from "./personas.js";
import { JsonlRationaleSink, rationaleWriterFor } from "./rationale.js";
import { SdkUnderwriterChain } from "./sdk-chain.js";
import { FileBidStore } from "./state.js";

async function run(): Promise<void> {
  const cfg = loadConfig();
  const persona = PERSONAS[cfg.persona];
  const log = jsonLogger(`underwriter-${cfg.persona}`);
  const sink = new JsonlRationaleSink(cfg.rationalesFile);
  const bidder = new Bidder({
    chain: new SdkUnderwriterChain({ rpcUrl: cfg.rpcUrl, contractId: cfg.contractId, accountId: cfg.accountId, key: cfg.key }),
    strategy: personaStrategy(persona),
    store: new FileBidStore(cfg.stateFile),
    persona: cfg.persona,
    log,
    explain: rationaleWriterFor(persona, cfg.rationale),
    publish: (r) => sink.publish(r),
  });
  log.log("info", "underwriter starting", {
    mode: cfg.mode,
    persona: cfg.persona,
    account: cfg.accountId,
    contract: cfg.contractId,
    rationale: cfg.rationale.model ? "model" : "template",
  });
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      await bidder.tick().catch((e: unknown) => log.log("error", "tick failed", { error: String(e).slice(0, 300) }));
      await new Promise((r) => setTimeout(r, cfg.pollMs));
    }
  };
  const stop = () => {
    stopped = true;
    log.log("info", "underwriter stopping");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await loop();
}

run().catch((e: unknown) => {
  console.error(JSON.stringify({ service: "underwriters", level: "error", msg: "startup failed", error: (e as Error).message }));
  process.exit(1);
});
