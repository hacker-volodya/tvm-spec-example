import { Hashmap, Slice, Cell } from "ton3-core";
import type { IRFunction, IROperands, IROperandValue } from "../../core/ir";
import { isIRFunction } from "../../core/ir";

// Convert raw operand value (Slice/Cell/Hashmap/etc.) into IR-friendly form
// - Slices that are continuations are already lifted to IRFunction at callsite
// - Hashmap of continuations is converted to Map<number, IRFunction>
export function convertOperandValue(v: unknown): IROperandValue {
  // Continuation function embedded inline
  if (isIRFunction(v)) return { kind: 'cont', value: v };
  // Hashmap of continuations → Map<number, IRFunction>
  if (v instanceof Hashmap) {
    const m = new Map<number, IRFunction>();
    (v as Hashmap<number, unknown>).forEach((k: number, vv: unknown) => {
      if (isIRFunction(vv)) m.set(k, vv as IRFunction);
    });
    return { kind: 'cont_map', value: m } as IROperandValue;
  }
  // Primitive scalars
  if (typeof v === 'number') return { kind: 'int', value: v };
  if (typeof v === 'bigint') return { kind: 'bigint', value: v };
  if (typeof v === 'boolean') return { kind: 'bool', value: v };
  // TON data types
  if (v instanceof Slice) return { kind: 'slice', value: v };
  if (v instanceof Cell) return { kind: 'cell', value: v };
  // Fallback
  return { kind: 'other', value: v };
}

// Map all operands through convertOperandValue
export function convertOperands(ops: { [k: string]: unknown }): IROperands {
  const res: IROperands = [];
  for (const [k, v] of Object.entries(ops)) {
    res.push({ name: k, value: convertOperandValue(v) });
  }
  return res;
}
