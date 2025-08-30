import { formatIR, IRFunction } from "../ir";
import type { Program } from "../core/program";

export function printIR(fn: IRFunction, opts?: { methodId?: number }): string {
  return formatIR(fn, opts);
}

export function printProgram(p: Program): string {
  if (p.kind === 'single') {
    return printIR(p.entry);
  }
  const pairs = Array.from(p.methods.entries()).sort((a, b) => a[0] - b[0]);
  const out: string[] = [];
  for (const [id, fn] of pairs) {
    out.push(printIR(fn, { methodId: id }));
    out.push("");
  }
  return out.join("\n");
}

