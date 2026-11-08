/**
 * The arbiter's verdict format and the checks every verdict must pass
 * (rubric.md, "How the output is checked"). A verdict that fails is
 * rejected, never repaired: a model that goes off-script — or is talked
 * off-script by injected evidence — produces an invalid verdict, not a
 * wrong one.
 */

import { readFileSync } from "node:fs";

import { Ajv } from "ajv";

import { awardBps, type Weights } from "@recourse/jobs";

export interface Finding {
  field: string;
  document_says: string | null;
  agent_said: string | null;
  correct: boolean;
  quote_from_document: string;
}

export interface Verdict {
  upheld: boolean;
  findings: Finding[];
  award_bps: number;
  reasons: string;
}

export const RUBRIC_PATH = new URL("../rubric.md", import.meta.url);
export const SCHEMA_PATH = new URL("../rubric.schema.json", import.meta.url);

export const RUBRIC = readFileSync(RUBRIC_PATH, "utf8");
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as object;
const validateShape = new Ajv({ allErrors: true, strict: true }).compile(schema);

/** Parses and checks a verdict; throws listing every problem. */
export interface VerdictContext {
  weights: Weights;
  documentText: string;
  /** The agent's delivered JSON, from the signed response. */
  agentOutput: string;
}

/** Case- and separator-insensitive form used to check a value is in the document. */
export function normalise(s: string): string {
  return s.toLowerCase().replace(/,/g, "").replace(/\s+/g, " ");
}

/** Does `value` occur in `text` as a whole token (not inside a longer number or word)? */
export function containsToken(text: string, value: string): boolean {
  const v = normalise(value).trim();
  if (!v) return false;
  const esc = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(normalise(text));
}

export function checkVerdict(raw: unknown, ctx: VerdictContext): Verdict {
  const v = typeof raw === "string" ? parseJson(raw) : raw;
  if (!validateShape(v)) {
    const msg = (validateShape.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ");
    throw new Error(`verdict does not match rubric.schema.json: ${msg}`);
  }
  const verdict = v as Verdict;
  const problems: string[] = [];

  const fields = verdict.findings.map((f) => f.field);
  const expected = Object.keys(ctx.weights).sort();
  if (new Set(fields).size !== fields.length) problems.push("a field has more than one finding");
  if ([...fields].sort().join(",") !== expected.join(",")) problems.push(`findings must cover exactly: ${expected.join(", ")}`);

  // Facts the code knows, so the model cannot be talked out of them:
  //  - what the agent said is in its signed output;
  //  - "correct" means the agent said what the document says;
  //  - anything the model claims the document says must be in the document.
  let agent: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(ctx.agentOutput);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) agent = parsed as Record<string, unknown>;
  } catch {
    // An agent output that is not JSON leaves every field unstated (null).
  }
  const doc = normalise(ctx.documentText);
  for (const f of verdict.findings) {
    const said = agent[f.field];
    const actual = typeof said === "string" ? said : said === null || said === undefined ? null : JSON.stringify(said);
    if (f.agent_said !== actual) problems.push(`finding for ${f.field} misstates what the agent said`);
    if (f.correct !== (f.agent_said === f.document_says)) problems.push(`finding for ${f.field} marks correct inconsistently`);
    if (f.document_says !== null) {
      // The value must be in a quoted line that really is in the document, as a whole token:
      // the model cannot borrow another number from elsewhere, and "" or "100" inside "1000"
      // do not match.
      if (!f.quote_from_document || !doc.includes(normalise(f.quote_from_document))) {
        problems.push(`finding for ${f.field} needs a verbatim quote from the document`);
      } else if (!containsToken(f.quote_from_document, f.document_says)) {
        problems.push(`finding for ${f.field} claims the document says something its quote does not show`);
      }
    }
  }

  const wrong = verdict.findings.filter((f) => !f.correct);
  for (const f of wrong) {
    if (!f.quote_from_document || !ctx.documentText.includes(f.quote_from_document)) {
      problems.push(`finding for ${f.field} quotes text that is not in the document`);
    }
  }
  const knownWrong = wrong.map((f) => f.field).filter((f) => f in ctx.weights);
  const bps = knownWrong.length === wrong.length ? awardBps(knownWrong, ctx.weights) : -1;
  if (verdict.award_bps !== bps) problems.push(`award_bps ${verdict.award_bps} is not the sum of wrong fields' weights (${bps})`);
  if (verdict.upheld !== wrong.length > 0) problems.push("upheld must be true exactly when some finding is incorrect");

  if (problems.length) throw new Error(`invalid verdict: ${problems.join("; ")}`);
  return verdict;
}

function parseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    throw new Error("verdict is not JSON");
  }
}
