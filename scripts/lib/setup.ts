/**
 * Deploy, council DAO and seed as plain functions, shared by the CLIs
 * (`scripts/deploy.ts`, `scripts/deploy-dao.ts`, `scripts/seed.ts`), the
 * demo runner (`demo/run-demo.ts`) and the judge (`scripts/judge.ts`).
 *
 * Everything here writes its outputs under `.data/<network>-*.json`
 * (git-ignored, mode 600) through `save()`, exactly as the CLIs always did,
 * so the scenario scripts' `cast()` keeps working unchanged.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { Account, JsonRpcProvider, KeyPair, actions } from "near-api-js";

import { getRecourseConfig } from "../../packages/config/src/index.js";
import { RecourseClient } from "../../packages/sdk/src/index.js";
import { chainNow, clientAs, MINUTE_NS, ONE_NEAR, save, type Deployment, type Network, type SeededAccount, type SeededAccounts } from "./near.js";
import { sandboxModels } from "./sandbox-models.js";

/** Where the deployable wasm comes from, in order of preference. */
export const WASM_CANDIDATES = ["target/near/recourse/recourse.wasm", "contracts/recourse/res/recourse.wasm"];
/** Covers the code's storage (~0.5 MB at 1e19 yocto/byte) plus a buffer for contract-paid records. */
const CONTRACT_FUNDING = 8n * ONE_NEAR;
const DAO_FUNDING = 6n * ONE_NEAR;
const INIT_GAS = 100_000_000_000_000n;
export const DEFAULT_DAO_WASM = "tests/fixtures/sputnikdao2.wasm";

export function resolveWasm(explicit?: string): string {
  const candidates = explicit ? [explicit] : WASM_CANDIDATES;
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `no contract wasm found (looked at ${candidates.join(", ")}).\n` +
        "Build it with `pnpm build:contract:dev`, or use the prebuilt one in contracts/recourse/res/.",
    );
  }
  return found;
}

export interface DeployOptions {
  net: Network;
  p: JsonRpcProvider;
  owner: Account;
  contractId?: string;
  wasmPath?: string;
  bondAsset?: "Native" | "Ft";
  usdcContractId?: string;
  councilId?: string | null;
  log?: (s: string) => void;
}

/**
 * Deploys and initialises the contract in ONE transaction, so no one can call
 * `new()` in between and make themselves owner. The contract account gets NO
 * access key: once deployed, nobody — including the owner — can redeploy it
 * or move its funds outside the contract's own methods (T16).
 */
export async function deployContract(o: DeployOptions): Promise<Deployment & { config: unknown }> {
  const log = o.log ?? (() => {});
  const contractId = o.contractId ?? `recourse.${o.owner.accountId}`;
  if (!contractId.endsWith(`.${o.owner.accountId}`)) {
    throw new Error(`contract id must be a sub-account of the owner (${o.owner.accountId})`);
  }
  const wasmPath = resolveWasm(o.wasmPath);
  const wasm = readFileSync(wasmPath);
  const sha = createHash("sha256").update(wasm).digest("hex");
  const cfg = getRecourseConfig({
    network: o.net,
    bondAsset: o.bondAsset,
    usdcContractId: o.usdcContractId,
    councilDaoId: o.councilId ?? null,
  });

  log(`deploying ${contractId} from ${wasmPath} (${wasm.length} bytes, sha256 ${sha.slice(0, 16)}…)`);
  await o.owner.signAndSendTransaction({
    receiverId: contractId,
    actions: [
      actions.createAccount(),
      actions.transfer(CONTRACT_FUNDING),
      actions.deployContract(new Uint8Array(wasm)),
      actions.functionCall("new", { config: cfg, owner: o.owner.accountId }, INIT_GAS, 0n),
    ],
  });

  const c = new RecourseClient(contractId, o.p);
  const [onChainCfg, roles, s] = await Promise.all([c.getConfig(), c.getRoles(), c.solvency()]);
  if (roles.owner !== o.owner.accountId) throw new Error("owner mismatch after init");
  if (!s.ok) throw new Error("solvency check failed right after init");

  const dep = {
    network: o.net,
    contractId,
    owner: o.owner.accountId,
    wasmSha256: sha,
    config: onChainCfg,
    deployedAt: new Date().toISOString(),
  };
  save(o.net, "deployment", dep);
  return dep;
}

export interface DaoDeployment {
  network: Network;
  daoId: string;
  owner: string;
  councilMembers: string[];
  wasmSha256: string;
  deployedAt: string;
}

/** Deploys and initialises a Sputnik DAO v2 whose council is `members` (default: the owner). */
export async function deployDao(o: {
  net: Network;
  p: JsonRpcProvider;
  owner: Account;
  daoId?: string;
  members?: string[];
  wasmPath?: string;
  log?: (s: string) => void;
}): Promise<DaoDeployment> {
  const log = o.log ?? (() => {});
  const daoId = o.daoId ?? `council.${o.owner.accountId}`;
  if (!daoId.endsWith(`.${o.owner.accountId}`)) throw new Error(`dao id must be a sub-account of the owner (${o.owner.accountId})`);
  const wasmPath = o.wasmPath ?? DEFAULT_DAO_WASM;
  if (!existsSync(wasmPath)) throw new Error(`Sputnik DAO wasm not found at ${wasmPath}`);
  const wasm = readFileSync(wasmPath);
  const sha = createHash("sha256").update(wasm).digest("hex");
  const members = (o.members ?? [o.owner.accountId]).filter(Boolean);

  log(`deploying Sputnik DAO ${daoId} (council: ${members.join(", ")})`);
  await o.owner.signAndSendTransaction({
    receiverId: daoId,
    actions: [
      actions.createAccount(),
      actions.transfer(DAO_FUNDING),
      actions.deployContract(new Uint8Array(wasm)),
      actions.functionCall(
        "new",
        { config: { name: "recourse-council", purpose: "Recourse appeal council for claim verdict disputes", metadata: "" }, policy: members },
        INIT_GAS,
        0n,
      ),
    ],
  });
  const dao: DaoDeployment = { network: o.net, daoId, owner: o.owner.accountId, councilMembers: members, wasmSha256: sha, deployedAt: new Date().toISOString() };
  save(o.net, "dao", dao);
  return dao;
}

/** The demo cast. `agent2`, `underwriter2`, `underwriter3` exist for the market scenario and the adversarial suite. */
export const FUNDING: Record<keyof SeededAccounts, bigint> = {
  agent: 20n * ONE_NEAR,
  agent2: 20n * ONE_NEAR,
  underwriter: 2n * ONE_NEAR,
  underwriter2: 2n * ONE_NEAR,
  underwriter3: 2n * ONE_NEAR,
  lp: 170n * ONE_NEAR,
  client: 25n * ONE_NEAR,
  keeper: 2n * ONE_NEAR,
  arbiter: 12n * ONE_NEAR,
  stranger: 2n * ONE_NEAR,
};

export const VAULT_CAPITAL = 50n * ONE_NEAR;

/**
 * Creates the cast on a fresh deployment: an agent with a 10 NEAR bond, three
 * underwriter vaults with 50 NEAR each from one LP, coverage binding the first
 * vault to the agent (the Phase 1 stand-in for a won bid round), a bonded
 * arbiter, a keeper, a client, a bystander, and a second agent with a bond but
 * no history or coverage. Allow-lists the sandbox/testnet TEE signing key.
 */
export async function seed(o: { net: Network; p: JsonRpcProvider; owner: Account; dep: Deployment; log?: (s: string) => void }): Promise<SeededAccounts> {
  const log = o.log ?? (() => {});
  const { net, p, owner, dep } = o;
  if (dep.owner !== owner.accountId) throw new Error(`deployment owner is ${dep.owner}, not ${owner.accountId}`);

  // 1. Accounts, each funded in one transaction with its own new key.
  const suffix = Date.now().toString(36);
  const accounts = {} as SeededAccounts;
  for (const [role, amount] of Object.entries(FUNDING) as [keyof SeededAccounts, bigint][]) {
    const kp = KeyPair.fromRandom("ed25519");
    const accountId = `${role}-${suffix}.${owner.accountId}`;
    await owner.signAndSendTransaction({
      receiverId: accountId,
      actions: [actions.createAccount(), actions.transfer(amount), actions.addFullAccessKey(kp.getPublicKey())],
    });
    accounts[role] = { accountId, privateKey: kp.toString() } satisfies SeededAccount;
  }
  save(net, "accounts", accounts);
  log(`created ${Object.keys(accounts).length} accounts (keys in .data/${net}-accounts.json)`);

  // 2. Roles and the TEE signer.
  const asOwner = new RecourseClient(dep.contractId, p, owner);
  await asOwner.addKeeper(accounts.keeper.accountId);
  await asOwner.addArbiter(accounts.arbiter.accountId);
  for (const s of sandboxModels().signers) {
    if (!(await asOwner.getSigner(s.address))) await asOwner.registerSigner(s.address, s.model, s.reportHash, "ProviderTee");
  }

  // 3. Agents.
  const agent = clientAs(dep.contractId, p, accounts.agent);
  await agent.registerAgent("ipfs://recourse/agents/extraction-v1", accounts.agent.accountId);
  await agent.postBond(10n * ONE_NEAR);
  const agent2 = clientAs(dep.contractId, p, accounts.agent2);
  await agent2.registerAgent("ipfs://recourse/agents/extraction-v2", accounts.agent2.accountId);
  await agent2.postBond(10n * ONE_NEAR);

  // 4. The arbiter is bonded too: the council fines it if it is overturned (T7).
  await clientAs(dep.contractId, p, accounts.arbiter).postBond(10n * ONE_NEAR);

  // 5. Three vaults, one LP.
  const lp = clientAs(dep.contractId, p, accounts.lp);
  for (const role of ["underwriter", "underwriter2", "underwriter3"] as const) {
    await clientAs(dep.contractId, p, accounts[role]).createVault();
    await lp.depositVault(accounts[role].accountId, VAULT_CAPITAL);
  }

  // 6. Coverage for the first agent from the first vault.
  const expires = (await chainNow(p)) + 24n * 60n * MINUTE_NS;
  await clientAs(dep.contractId, p, accounts.underwriter).bindCoverage(accounts.agent.accountId, (20n * ONE_NEAR).toString(), 200, expires.toString());

  const s = await asOwner.solvency();
  log(`agent ${accounts.agent.accountId} bonded 10 NEAR; agent2 ${accounts.agent2.accountId} bonded 10 NEAR, no coverage`);
  log(`3 vaults × 50 NEAR; coverage 20 NEAR @ 200 bps from ${accounts.underwriter.accountId}`);
  log(`solvency ok=${s.ok} liabilities=${s.liabilities} surplus=${s.surplus}`);
  if (!s.ok) throw new Error("solvency check failed after seeding");
  return accounts;
}
