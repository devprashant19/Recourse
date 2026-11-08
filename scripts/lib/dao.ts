/**
 * The council's side of an appeal: a Sputnik DAO v2 `FunctionCall` proposal
 * that executes `council_decide` on the Recourse contract once approved.
 * Only the DAO account can call `council_decide`, so this is the ONLY way a
 * verdict gets overturned (THREAT_MODEL T7).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Account, actions } from "near-api-js";

import { DATA_DIR, ONE_NEAR, type Network } from "./near.js";
import type { DaoDeployment } from "./setup.js";

export function loadDao(net: Network): DaoDeployment | null {
  const p = join(DATA_DIR, `${net}-dao.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as DaoDeployment) : null;
}

/** Proposes `council_decide(claim, upheld, award)` as `member` and approves it; Sputnik executes it. */
export async function councilDecide(p: {
  dao: DaoDeployment;
  member: Account;
  contractId: string;
  claimId: number;
  upheld: boolean;
  award: string;
}): Promise<number> {
  const args = Buffer.from(JSON.stringify({ claim_id: p.claimId, upheld: p.upheld, award: p.award })).toString("base64");
  const proposal = {
    description: `Council decision on claim ${p.claimId}`,
    kind: {
      FunctionCall: {
        receiver_id: p.contractId,
        actions: [{ method_name: "council_decide", args, deposit: "0", gas: "100000000000000" }],
      },
    },
  };
  const added = await p.member.signAndSendTransaction({
    receiverId: p.dao.daoId,
    actions: [actions.functionCall("add_proposal", { proposal }, 50_000_000_000_000n, ONE_NEAR)],
  });
  const raw = (added.status as { SuccessValue?: string }).SuccessValue ?? "";
  const id = Number(Buffer.from(raw, "base64").toString("utf8") || "0");
  await p.member.signAndSendTransaction({
    receiverId: p.dao.daoId,
    actions: [actions.functionCall("act_proposal", { id, action: "VoteApprove" }, 250_000_000_000_000n, 0n)],
  });
  return id;
}
