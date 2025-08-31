import { Hashmap } from "ton3-core";
import type { IRFunction, IROperands, IROperandValue } from "../../core/ir";
import { isIRFunction } from "../../core/ir";

// Convert raw operand value (Slice/Cell/Hashmap/etc.) into IR-friendly form
// - Slices that are continuations are already lifted to IRFunction at callsite
// - Hashmap of continuations is converted to Map<number, IRFunction>
export function convertOperandValue(v: unknown): IROperandValue {
  if (isIRFunction(v)) return v;
  if (v instanceof Hashmap) {
    const m = new Map<number, IRFunction>();
    (v as Hashmap<number, unknown>).forEach((k: number, vv: unknown) => {
      if (isIRFunction(vv)) m.set(k, vv as IRFunction);
    });
    return m;
  }
  return v as IROperandValue;
}

// Map all operands through convertOperandValue
export function convertOperands(ops: { [k: string]: unknown }): IROperands {
  const res: IROperands = {};
  for (const [k, v] of Object.entries(ops)) {
    res[k] = convertOperandValue(v);
  }
  return res;
}
