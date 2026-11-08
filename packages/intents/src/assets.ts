import type { TokenInfo } from "./types.js";

/**
 * Finds exactly one token by chain and symbol (case-insensitive). Throws if
 * there is none or more than one: asset ids are never guessed or hard-coded.
 */
export function findAsset(tokens: readonly TokenInfo[], blockchain: string, symbol: string): TokenInfo {
  const hits = tokens.filter(
    (t) =>
      t.blockchain.toLowerCase() === blockchain.toLowerCase() &&
      t.symbol.toLowerCase() === symbol.toLowerCase(),
  );
  if (hits.length !== 1) {
    throw new Error(`expected one ${symbol} on ${blockchain} in /v0/tokens, found ${hits.length}`);
  }
  return hits[0]!;
}

/** The asset with this id, or an error naming it. */
export function assetById(tokens: readonly TokenInfo[], assetId: string): TokenInfo {
  const t = tokens.find((x) => x.assetId === assetId);
  if (!t) throw new Error(`1Click does not route ${assetId}`);
  return t;
}

/** USDC on NEAR and on Base, resolved from the live token list at startup. */
export interface UsdcAssets {
  near: TokenInfo;
  base: TokenInfo;
}

export function resolveUsdc(tokens: readonly TokenInfo[]): UsdcAssets {
  return { near: findAsset(tokens, "near", "USDC"), base: findAsset(tokens, "base", "USDC") };
}
