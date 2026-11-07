/**
 * The sandbox/testnet TEE signing key: the label-derived throwaway key from
 * scripts/receipt-test-vectors.ts ("recourse/test-vector/tee"). It stands in
 * for a NEAR AI Cloud TEE until Phase 2 records real signatures. Never
 * allow-list it on mainnet.
 */

import { Wallet, keccak256, toUtf8Bytes } from "ethers";

export const TEE_MODEL = "deepseek-ai/DeepSeek-V3.1";
export const teeWallet = () => new Wallet(keccak256(toUtf8Bytes("recourse/test-vector/tee")));
