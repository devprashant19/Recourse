"use client";

import { useState } from "react";

import { ARTIFACT_URI_PREFIX, verifyReceipt, type Receipt as OffchainReceipt } from "@recourse/receipts";
import type { Receipt as OnchainReceipt } from "@recourse/sdk";

import { api } from "@/lib/api";
import { Hash, Pill } from "./ui";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const hashOf = (uri: string) => (uri.startsWith(ARTIFACT_URI_PREFIX) ? uri.slice(ARTIFACT_URI_PREFIX.length) : null);

/**
 * Re-runs every receipt check IN THE BROWSER: fetches the exact bytes,
 * re-hashes them, re-derives the signed text, recovers the TEE signer with
 * EIP-191, re-checks the attestation binding, and compares all of it with
 * what the contract recorded on-chain. The same pure `verifyReceipt` the
 * arbiter, the CLI and the judge use.
 */
export function VerifyPanel({ receipt, reportUri, onChain }: { receipt: OffchainReceipt; reportUri?: string; onChain?: OnchainReceipt | null }) {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const reqH = hashOf(receipt.artifacts.request_uri);
      const respH = hashOf(receipt.artifacts.response_uri);
      const repH = reportUri ? hashOf(reportUri) : null;
      if (!reqH || !respH) throw new Error("receipt artifacts are not content-addressed");
      const [request, response, report] = await Promise.all([api.artifact(reqH), api.artifact(respH), repH ? api.artifact(repH) : Promise.resolve(undefined)]);
      const dev = /dev-fixture/.test(receipt.attestation.verifier);
      const r = verifyReceipt(receipt, { request, response, ...(report ? { report } : {}) }, { requireAttestation: !dev });
      const out: Check[] = [
        { name: "Request bytes hash to request_hash", ok: !r.errors.some((e) => /request/i.test(e)), detail: receipt.request_hash },
        { name: "Response bytes hash to response_hash", ok: !r.errors.some((e) => /response/i.test(e)), detail: receipt.response_hash },
        { name: "EIP-191 recovery gives the signing address", ok: r.recovered_signer?.toLowerCase() === receipt.signing_address.toLowerCase(), detail: r.recovered_signer ?? "—" },
        {
          name: dev ? "Attestation binding (dev fixture: no TEE, not required)" : "Attestation report binds signer + nonce",
          ok: dev || !r.errors.some((e) => /attest|report|nonce|quote/i.test(e)),
          detail: receipt.attestation.verifier,
        },
      ];
      if (onChain) {
        out.push({
          name: "Matches the receipt the contract accepted on-chain",
          ok: onChain.request_hash === receipt.request_hash && onChain.response_hash === receipt.response_hash && `0x${onChain.signer}` === receipt.signing_address.toLowerCase() && onChain.model_id === receipt.model_id,
          detail: `on-chain signer 0x${onChain.signer}`,
        });
      }
      out.push({ name: "Whole receipt valid", ok: r.ok, detail: r.ok ? `receipt_hash ${r.receipt_hash}` : r.errors.join("; ") });
      setChecks(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-medium">Signed inside a TEE, checked on-chain</div>
          <div className="text-xs text-dim">
            model <span className="font-mono">{receipt.model_id}</span> · signer <Hash value={receipt.signing_address} />
          </div>
        </div>
        <button className="btn-primary" onClick={run} disabled={busy}>
          {busy ? "Verifying…" : "Verify receipt"}
        </button>
      </div>
      {error ? <div className="mt-3 text-sm text-bad">{error}</div> : null}
      {checks ? (
        <ul className="mt-3 space-y-1.5 text-sm">
          {checks.map((c) => (
            <li key={c.name} className="flex flex-wrap items-center gap-2">
              <Pill tone={c.ok ? "good" : "bad"}>{c.ok ? "pass" : "fail"}</Pill>
              <span>{c.name}</span>
              <span className="truncate font-mono text-xs text-dim" title={c.detail}>
                {c.detail}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-dim">Runs in your browser: re-hashes the exact bytes and recovers the signer. Nothing is taken on trust from the server.</p>
      )}
    </div>
  );
}
