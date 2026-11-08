/** Display helpers. Amounts arrive as decimal strings in the bond asset's smallest unit. */

export const ASSET = process.env.NEXT_PUBLIC_ASSET_SYMBOL ?? "NEAR";
export const DECIMALS = Number(process.env.NEXT_PUBLIC_ASSET_DECIMALS ?? 24);
/** e.g. https://testnet.nearblocks.io/txns/ — empty on the sandbox, where there is no explorer. */
export const EXPLORER_TX = process.env.NEXT_PUBLIC_EXPLORER_TX ?? "";
export const EXPLORER_ACCOUNT = process.env.NEXT_PUBLIC_EXPLORER_ACCOUNT ?? "";

export function amount(raw: string | number | bigint | null | undefined, digits = 3): string {
  if (raw === null || raw === undefined || raw === "") return "—";
  const v = BigInt(raw);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(DECIMALS);
  const whole = a / base;
  const frac = (a % base).toString().padStart(DECIMALS, "0").slice(0, digits).replace(/0+$/, "");
  return `${neg ? "−" : ""}${whole.toLocaleString("en-US")}${frac ? `.${frac}` : ""} ${ASSET}`;
}

export const bps = (b: number | null | undefined) => (b === null || b === undefined ? "—" : `${(b / 100).toFixed(b % 100 === 0 ? 0 : 2)}%`);

export function short(s: string | null | undefined, head = 6, tailN = 4): string {
  if (!s) return "—";
  return s.length <= head + tailN + 1 ? s : `${s.slice(0, head)}…${s.slice(-tailN)}`;
}

export function account(a: string | null | undefined): string {
  if (!a) return "—";
  // Seeded sandbox names are "<role>-<suffix>.<owner>": show the role.
  const m = a.match(/^([a-z0-9]+)-[a-z0-9]{6,}\.(.+)$/);
  return m ? m[1]! : a;
}

export function time(ns: string | null | undefined): string {
  if (!ns) return "—";
  const ms = Number(BigInt(ns) / 1_000_000n);
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export function countdown(ns: string | null | undefined, nowMs = Date.now()): string {
  if (!ns) return "—";
  const left = Number(BigInt(ns) / 1_000_000n) - nowMs;
  if (left <= 0) return "closed";
  const s = Math.floor(left / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m left` : `${m}m ${s % 60}s left`;
}

export const pretty = (s: string) => s.replace(/_/g, " ");
