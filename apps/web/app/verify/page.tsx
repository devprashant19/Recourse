"use client";

import { useState } from "react";

import { receiptShapeErrors, type Receipt } from "@recourse/receipts";

import { VerifyPanel } from "@/components/verify-panel";
import { api, type PublishedReceipt } from "@/lib/api";

export default function VerifyPage() {
  const [input, setInput] = useState("");
  const [receipt, setReceipt] = useState<{ receipt: Receipt; reportUri?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    setReceipt(null);
    const s = input.trim();
    try {
      if (/^\d+$/.test(s)) {
        // An engagement id: fetch the receipt the worker published for it.
        const pr: PublishedReceipt = await api.receipt(Number(s));
        setReceipt({ receipt: pr.receipt as unknown as Receipt, reportUri: pr.report_uri });
        return;
      }
      const j = JSON.parse(s) as unknown;
      const r = (j as { receipt?: unknown }).receipt ?? j;
      const errs = receiptShapeErrors(r);
      if (errs.length) throw new Error(errs.join("; "));
      setReceipt({ receipt: r as Receipt, reportUri: (j as { report_uri?: string }).report_uri });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="max-w-3xl">
      <h1 className="page-title">Verify a receipt</h1>
      <p className="mt-1 text-sm text-dim">
        Paste a receipt JSON (for example one from <code className="font-mono">demo/fixtures/receipts/</code>) or type an engagement id. Every check runs in your browser: the exact bytes are fetched by their SHA-256, re-hashed, and the TEE signer is recovered with EIP-191.
      </p>
      <textarea
        className="mt-4 h-48 w-full rounded-xl border border-line bg-panel p-3 font-mono text-xs"
        placeholder='{"version":1,"engagement_id":…}   or   12'
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />
      <button className="btn-primary mt-3" onClick={load}>
        Load
      </button>
      {error ? <div className="mt-3 text-sm text-bad">{error}</div> : null}
      {receipt ? (
        <div className="mt-6">
          <VerifyPanel receipt={receipt.receipt} reportUri={receipt.reportUri} />
        </div>
      ) : null}
    </div>
  );
}
