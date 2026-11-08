/**
 * A plain ASCII table for the demo and judge reports: no dependency, readable
 * in a terminal, in CI logs and by an AI screener in one glance.
 */

export interface TableOptions {
  /** Wrap a column at this width (by header name). */
  maxWidth?: Record<string, number>;
}

function wrap(s: string, width: number): string[] {
  if (s.length <= width) return [s];
  const out: string[] = [];
  let line = "";
  for (const word of s.split(/\s+/)) {
    if (word.length > width) {
      if (line) {
        out.push(line);
        line = "";
      }
      for (let i = 0; i < word.length; i += width) out.push(word.slice(i, i + width));
      continue;
    }
    if ((line + " " + word).trim().length > width) {
      out.push(line);
      line = word;
    } else line = (line + " " + word).trim();
  }
  if (line) out.push(line);
  return out;
}

export function table(headers: string[], rows: string[][], o: TableOptions = {}): string {
  const cells = rows.map((r) => r.map((c, i) => wrap(String(c ?? ""), o.maxWidth?.[headers[i]!] ?? 1000)));
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((r) => Math.max(...(r[i] ?? [""]).map((l) => l.length)))));
  const sep = "+" + widths.map((w) => "-".repeat(w + 2)).join("+") + "+";
  const line = (cols: string[]) => "| " + cols.map((c, i) => c.padEnd(widths[i]!)).join(" | ") + " |";
  const out = [sep, line(headers), sep];
  for (const r of cells) {
    const height = Math.max(...r.map((c) => c.length));
    for (let k = 0; k < height; k++) out.push(line(r.map((c) => c[k] ?? "")));
    out.push(sep);
  }
  return out.join("\n");
}
