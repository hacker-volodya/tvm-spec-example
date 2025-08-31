import { Slice } from "ton3-core";
import type { IRFunction, IROperands, IROpPrim, IRValueRef } from "../core/ir";
import { OpcodeParser, VarMap } from "../disasm";
import { GuardUnresolvedError, Stack, StackUnderflowError, StackVariable } from "../stackAnalysis";
import { buildOp } from "./lifter/stackEffects";
import { convertOperands } from "./lifter/operands";

// Public API: lift a raw code slice to IRFunction
export function liftSliceToIR(slice: Slice): IRFunction { return lift(slice); }

// Internal: integrated continuation + disassembly logic encapsulated within lifter.
// No external exports from here besides liftSliceToIR.

function lift(slice: Slice, initialStack: StackVariable[] = []): IRFunction {
  const body: IROpPrim[] = [];
  let stack = new Stack(initialStack);
  const args: StackVariable[] = [];
  let decompileError: any = null;
  let disassembleError: any = null;
  const asmTail: { spec: any; operands: IROperands }[] = [];

  while (slice.bits.length > 0) {
    let spec: any;
    let operands: VarMap;
    try {
      [spec, operands] = OpcodeParser.nextInstruction(slice);
      // Lift inline continuation operands using spec display_hints instead of hardcoded list
      const bytecodeOps: any[] = spec?.bytecode?.operands ?? [];
      for (const opSpec of bytecodeOps) {
        const hints: any[] | undefined = opSpec?.display_hints;
        if (!hints || hints.length === 0) continue;
        if (!hints.some((h) => h && h.type === "continuation")) continue;
        const operandName: string = opSpec.name;
        const opVal = (operands as any)[operandName];
        if (opVal instanceof Slice) {
          (operands as any)[operandName] = lift(opVal as Slice);
        }
      }
    } catch (e) {
      disassembleError = e;
      break;
    }

    if (decompileError == null) {
      for (let t = 0; ; t++) {
        try {
          const stack2 = stack.copy();
          const op = buildOp(spec, operands, stack2);
          if (op) body.push(op);
          stack = stack2;
          break;
        } catch (e) {
          if (e instanceof StackUnderflowError && t < 10) {
            const newArgs = stack.insertArgs(args.length, e.underflowDepth);
            args.unshift(...newArgs);
            continue;
          }
          if (e instanceof GuardUnresolvedError) {
            decompileError = e;
            break;
          }
          decompileError = e;
          break;
        }
      }
    }

    if (decompileError != null) {
      asmTail.push({ spec, operands: convertOperands(operands) });
    }

    while (slice.bits.length == 0 && slice.refs.length > 0) {
      slice = slice.loadRef().slice();
    }
  }

  const result: IRValueRef[] = stack.copyEntries().map((s) => ({ id: s.name }));
  const asmTailOut = asmTail.length ? asmTail : undefined;
  const tailSliceInfo = (slice.bits.length > 0 || slice.refs.length > 0) ? String(slice) : undefined;

  return {
    kind: 'function',
    args: args.map((a) => ({ id: a.name })),
    body,
    result,
    asmTail: asmTailOut,
    tailSliceInfo,
    decompileError: decompileError ? String(decompileError) : null,
    disassembleError: disassembleError ? String(disassembleError) : null,
  };
}
