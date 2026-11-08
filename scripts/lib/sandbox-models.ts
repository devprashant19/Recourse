/**
 * Which models and TEE signers the sandbox replays.
 *
 * With a genuine set in demo/fixtures/near-ai (recorded from NEAR AI Cloud by
 * `pnpm record-fixtures --live`), the worker and arbiter use the recorded
 * models, and setup allow-lists the real TEE signing addresses those
 * recordings were signed by, each with the sha256 of the attestation report
 * Intel's verifier checked at recording time. Without one, both use the dev
 * model and the throwaway dev key.
 *
 * The dev key is allow-listed either way: scenarios 05-07 and the adversarial
 * suite sign synthetic receipts with it to exercise the contract's mechanics.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { loadFixtureSet, type FixtureSet } from "../../packages/adapters/src/fixtures.js";
import { sha256Hex } from "../../packages/receipts/src/index.js";
import { DEV_MODEL } from "../../demo/fixtures/plan.js";
import { TEE_MODEL, teeWallet } from "./tee.js";

export interface SandboxSigner {
  /** 40 lowercase hex chars, no 0x. */
  address: string;
  model: string;
  /** sha256 of the attestation report that bound this address. */
  reportHash: string;
}

export interface SandboxModels {
  kind: "genuine" | "dev";
  worker: string;
  arbiter: string;
  signers: SandboxSigner[];
}

const FIXTURES = "demo/fixtures";

/** The model id inside a provider_tee signed text "<model>:<request_hash>:<response_hash>". */
function modelOf(text: string): string {
  const parts = text.split(":");
  if (parts.length < 3) throw new Error(`not a provider_tee signed text: ${text.slice(0, 80)}`);
  return parts.slice(0, -2).join(":");
}

function genuineSigners(set: FixtureSet): SandboxSigner[] {
  const out = new Map<string, SandboxSigner>();
  for (const it of set.interactions) {
    const model = modelOf(it.signature.text);
    const rec = set.models[model];
    if (!rec) throw new Error(`genuine set has no attestation report for ${model}`);
    const address = it.signature.signing_address.toLowerCase().replace(/^0x/, "");
    const prev = out.get(address);
    if (prev && prev.model !== model) throw new Error(`signer ${address} signs for both ${prev.model} and ${model}`);
    out.set(address, { address, model, reportHash: sha256Hex(new Uint8Array(Buffer.from(rec.report, "base64"))) });
  }
  return [...out.values()];
}

export function sandboxModels(dir = FIXTURES): SandboxModels {
  const dev: SandboxSigner = { address: teeWallet().address.toLowerCase().slice(2), model: TEE_MODEL, reportHash: "00".repeat(32) };
  const genuineDir = join(dir, "near-ai");
  if (!existsSync(join(genuineDir, "fixtures.json"))) return { kind: "dev", worker: DEV_MODEL, arbiter: DEV_MODEL, signers: [dev] };
  const set = loadFixtureSet(genuineDir);
  if (!set.roles) throw new Error(`${genuineDir}/fixtures.json has no roles; re-record with pnpm record-fixtures --live --force`);
  return { kind: "genuine", worker: set.roles.worker, arbiter: set.roles.arbiter, signers: [...genuineSigners(set), dev] };
}
