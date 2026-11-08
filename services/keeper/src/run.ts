/**
 * Entry point for running the keeper service from CLI.
 */

import { OneClickClient } from "@recourse/intents";

import { loadKeeperConfig } from "./config.js";
import { KeeperLogger } from "./logger.js";
import { SdkKeeperChain } from "./sdk-chain.js";
import { KeeperService } from "./service.js";

async function main() {
  const log = new KeeperLogger("keeper");
  const config = loadKeeperConfig();

  const chain = new SdkKeeperChain({
    rpcUrl: config.rpcUrl,
    contractId: config.contractId,
    keeperAccountId: config.keeperAccountId,
    keeperKey: config.keeperKey,
  });

  const api = new OneClickClient({
    baseUrl: config.oneClickUrl,
    jwt: config.oneClickJwt,
  });

  const service = new KeeperService(config, chain, api, log);

  const shutdown = () => {
    log.info("keeper_shutting_down");
    service.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await service.start();
}

main().catch((err) => {
  console.error("Keeper fatal error:", err);
  process.exit(1);
});
