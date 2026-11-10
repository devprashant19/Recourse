/**
 * The SDK must agree with the contract. `abi/recourse_abi.json` is generated
 * by `cargo near build` (refresh with `pnpm sdk:abi`); this test fails
 * if a method the client calls is missing, has a different kind, or takes
 * different argument names.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { METHODS } from "../src/client.js";
import { EVENT_NAMES } from "../src/events.js";

interface AbiFunction {
  name: string;
  kind: "view" | "call";
  params?: { args?: { name: string }[] };
}

const abi = JSON.parse(readFileSync(new URL("../abi/recourse_abi.json", import.meta.url), "utf8")) as {
  body: { functions: AbiFunction[] };
};
const byName = new Map(abi.body.functions.map((f) => [f.name, f]));

describe("SDK vs contract ABI", () => {
  for (const [name, spec] of Object.entries(METHODS)) {
    it(`${name} exists with the same kind and arguments`, () => {
      const f = byName.get(name);
      expect(f, `${name} missing from the contract ABI`).toBeDefined();
      expect(f!.kind).toBe(spec.kind);
      expect((f!.params?.args ?? []).map((a) => a.name)).toEqual([...spec.args]);
    });
  }

  it("covers every public contract method except internals", () => {
    const internal = new Set(["on_payout_transfer", "on_ft_paid", "on_ft_balance", "contract_source_metadata", "remove_arbiter", "remove_keeper", "remove_signer", "is_arbiter", "is_keeper", "prune_used_quotes"]);
    const missing = [...byName.keys()].filter((n) => !(n in METHODS) && !internal.has(n));
    expect(missing).toEqual([]);
  });

  it("event list matches the contract's events.rs", () => {
    const src = readFileSync(new URL("../../../contracts/recourse/src/events.rs", import.meta.url), "utf8");
    const names = [...src.matchAll(/=> "([a-z_]+)",/g)].map((m) => m[1]);
    expect([...names].sort()).toEqual([...EVENT_NAMES].sort());
  });
});
