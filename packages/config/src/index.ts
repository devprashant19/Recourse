/**
 * @recourse/config
 *
 * Mode, network, account ids, contract ids, asset ids — one typed file.
 *
 * Built in: Phase 1 & Phase 3.
 * Spec: phases/phase-01-contract-core.md, phases/phase-03-money-out.md
 */

export type Network = "sandbox" | "testnet" | "mainnet";

export const RPC_URLS: Record<Network, string> = {
  sandbox: "http://127.0.0.1:3030",
  testnet: "https://test.rpc.fastnear.com",
  mainnet: "https://free.rpc.fastnear.com",
};

export const USDC_CONTRACTS: Record<Network, string> = {
  sandbox: "test_token.near",
  testnet: "usdc.fakes.testnet",
  mainnet: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
};

export const SPUTNIK_DAO_FACTORIES: Record<Network, string> = {
  sandbox: "sputnik-dao.near",
  testnet: "sputnik-dao.testnet",
  mainnet: "sputnik-dao.near",
};

export const BASE_USDC_ASSET_ID =
  "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";

export const ONE_NEAR_YOCTO = 10n ** 24n;
export const ONE_USDC_UNITS = 1_000_000n;
export const MINUTE_NS = 60n * 1_000_000_000n;
export const HOUR_NS = 60n * MINUTE_NS;
export const DAY_NS = 24n * HOUR_NS;

export interface RecourseConfig {
  bond_asset: "Native" | { Ft: string };
  min_bond: string;
  withdrawal_cooldown: string;
  claim_window: string;
  appeal_window: string;
  bid_commit_window: string;
  bid_reveal_window: string;
  claim_stake_bps: number;
  base_bond_share_bps: number;
  min_bond_share_bps: number;
  max_vault_exposure_bps: number;
  council: string | null;
}

export interface ContractDeploymentOptions {
  network: Network;
  bondAsset?: "Native" | "Ft";
  usdcContractId?: string;
  councilDaoId?: string | null;
}

/** Returns the standard contract configuration for the given network. */
export function getRecourseConfig(opts: ContractDeploymentOptions): RecourseConfig {
  const { network, bondAsset, usdcContractId, councilDaoId } = opts;
  const isFt = bondAsset === "Ft" || (bondAsset === undefined && network === "mainnet");
  const ftToken = usdcContractId ?? USDC_CONTRACTS[network];

  if (network === "mainnet") {
    return {
      bond_asset: isFt ? { Ft: ftToken } : "Native",
      min_bond: (isFt ? 2n * ONE_USDC_UNITS : 5n * ONE_NEAR_YOCTO).toString(),
      withdrawal_cooldown: (7n * DAY_NS).toString(),
      claim_window: (72n * HOUR_NS).toString(),
      appeal_window: (48n * HOUR_NS).toString(),
      bid_commit_window: (10n * MINUTE_NS).toString(),
      bid_reveal_window: (10n * MINUTE_NS).toString(),
      claim_stake_bps: 500,
      base_bond_share_bps: 5000,
      min_bond_share_bps: 2000,
      max_vault_exposure_bps: 2500,
      council: councilDaoId ?? null,
    };
  }

  // Sandbox & Testnet default config
  return {
    bond_asset: isFt ? { Ft: ftToken } : "Native",
    min_bond: (isFt ? 2n * ONE_USDC_UNITS : 5n * ONE_NEAR_YOCTO).toString(),
    withdrawal_cooldown: (5n * MINUTE_NS).toString(),
    claim_window: (3n * MINUTE_NS).toString(),
    appeal_window: (3n * MINUTE_NS).toString(),
    bid_commit_window: MINUTE_NS.toString(),
    bid_reveal_window: MINUTE_NS.toString(),
    claim_stake_bps: 500,
    base_bond_share_bps: 5000,
    min_bond_share_bps: 2000,
    max_vault_exposure_bps: 2500,
    council: councilDaoId ?? null,
  };
}
