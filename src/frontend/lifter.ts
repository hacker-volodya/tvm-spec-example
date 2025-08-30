import { Hashmap, Slice } from "ton3-core";
import type { IRFunction, IROperands, IRInputs, IROpPrim, IROperandValue, IROutputs, IRValueDef, IRValueRef } from "../ir";
import { isIRFunction } from "../ir";
import { OpcodeParser, VarMap } from "../disasm";
import type { Instruction } from "../gen/tvm-spec";
import { GuardUnresolvedError, Stack, StackUnderflowError, StackVariable } from "../stackAnalysis";

// Public API: lift a raw code slice to IRFunction
export function liftSliceToIR(slice: Slice): IRFunction {
  return Lifter.lift(slice);
}

// Internal: integrated continuation + disassembly logic encapsulated within lifter.
// No external exports from here besides liftSliceToIR.

const CONTINUATIONS: { [key: string]: string[] } = {
  CALLREF: ["c"],
  JMPREF: ["c"],
  JMPREFDATA: ["c"],
  IFREF: ["c"],
  IFNOTREF: ["c"],
  IFJMPREF: ["c"],
  IFNOTJMPREF: ["c"],
  IFREFELSE: ["c"],
  IFELSEREF: ["c"],
  IFREFELSEREF: ["c1", "c2"],
  IFBITJMPREF: ["c"],
  IFNBITJMPREF: ["c"],
  PUSHCONT: ["s"],
  PUSHCONT_SHORT: ["s"],
};

class Lifter {
  private static isStackOp(spec: Instruction): boolean {
    return ["stack_basic", "stack_complex"].includes(spec.doc.category);
  }

  private static convertOperandValue(v: any): IROperandValue {
    if (isIRFunction(v)) return v;
    if (v instanceof Hashmap) {
      const m = new Map<number, IRFunction>();
      (v as Hashmap<number, any>).forEach((k: number, vv: any) => {
        if (isIRFunction(vv)) m.set(k, vv as IRFunction);
      });
      return m;
    }
    return v as IROperandValue;
  }

  private static convertOperands(ops: VarMap): IROperands {
    const res: IROperands = {};
    for (const [k, v] of Object.entries(ops)) {
      res[k] = this.convertOperandValue(v);
    }
    return res;
  }

  // Build and apply stack effects, return IROpPrim or null (for raw stack ops)
  private static buildOp(spec: Instruction, operands: VarMap, stack: Stack): IROpPrim | null {
    if (this.isStackOp(spec)) {
      stack.execStackInstruction(spec, operands);
      return null;
    }
    if (!spec.value_flow || !spec.value_flow.inputs || !spec.value_flow.outputs) {
      throw new Error(`instruction is missing value flow: ${spec.mnemonic}`);
    }

    const stackInputs: VarMap = {};
    if (!spec.value_flow.inputs.stack) {
      throw new Error(`Unconstrained stack input while parsing ${spec.mnemonic}`);
    }
    // Inputs: deepest -> top in spec, pop from top
    for (const input of spec.value_flow.inputs.stack.slice().reverse()) {
      if (input.type === 'simple') {
        stackInputs[input.name] = { var: stack.pop(), types: input.value_types };
      } else if (input.type === 'array') {
        const lenVar = input.length_var as string;
        let count: number | null = null;
        if (Object.prototype.hasOwnProperty.call(operands, lenVar)) {
          const v = operands[lenVar];
          if (typeof v === 'number') count = v as number;
        }
        if (count == null) throw new Error(`not supported dynamic array length '${lenVar}' while parsing ${spec.mnemonic}`);
        let idx = 0;
        for (let i = 0; i < count; i++) {
          for (const ent of input.array_entry.slice().reverse()) {
            if (ent.type === 'simple') {
              const v = stack.pop();
              const key = `${ent.name}${idx}`;
              (stackInputs as any)[key] = { var: v, types: ent.value_types };
              idx++;
            } else if (ent.type === 'const') {
              const v = stack.pop();
              const key = `const_in_${idx}`;
              (stackInputs as any)[key] = { var: v, types: [ent.value_type] as any };
              idx++;
            } else if (ent.type === 'conditional' || ent.type === 'array') {
              throw new Error(`not supported nested '${ent.type}' inside array input while parsing ${spec.mnemonic}`);
            }
          }
        }
      } else {
        throw new Error(`not supported stack input '${(input as any).type}' while parsing ${spec.mnemonic}`);
      }
    }

    const stackOutputs: VarMap = {};
    let constCounter = 0;
    if (!spec.value_flow.outputs.stack) {
      throw new Error(`Unconstrained stack output while parsing ${spec.mnemonic}`);
    }
    let pushedThisInsn = 0;
    for (const output of spec.value_flow.outputs.stack) {
      if (output.type === 'simple') {
        const v = stack.push();
        pushedThisInsn += 1;
        stackOutputs[output.name] = { var: v, types: output.value_types };
      } else if (output.type === 'const') {
        const v = stack.push();
        pushedThisInsn += 1;
        stackOutputs[`const${constCounter++}`] = { var: v, types: [output.value_type] };
      } else if (output.type === 'array') {
        const lenVar = output.length_var as string;
        let count: number | null = null;
        if (Object.prototype.hasOwnProperty.call(operands, lenVar)) {
          const v = operands[lenVar];
          if (typeof v === 'number') count = v as number;
        }
        if (count == null) throw new Error(`not supported dynamic array length '${lenVar}' while parsing ${spec.mnemonic}`);
        let idx = 0;
        for (let i = 0; i < count; i++) {
          for (const ent of output.array_entry) {
            if (ent.type === 'simple') {
              const v = stack.push();
              pushedThisInsn += 1;
              const key = `${ent.name}${idx}`;
              (stackOutputs as any)[key] = { var: v, types: ent.value_types };
              idx++;
            } else if (ent.type === 'const') {
              const v = stack.push();
              pushedThisInsn += 1;
              const key = `const${constCounter++}`;
              (stackOutputs as any)[key] = { var: v, types: [ent.value_type] };
            } else if (ent.type === 'conditional' || ent.type === 'array') {
              throw new Error(`not supported nested '${ent.type}' inside array output while parsing ${spec.mnemonic}`);
            }
          }
        }
      } else if (output.type === 'conditional') {
        const arms = [...(output.match ?? []).map(x => x.stack ?? []), ...(output.else ? [output.else] : [])];
        const armsCount = arms.length;
        stack.ensureGuard(pushedThisInsn, armsCount);
        arms.forEach((arm, idx) => {
          const newVars: StackVariable[] = [];
          for (const ent of arm) {
            if (ent.type === 'simple') newVars.push(Stack.allocVar());
            else if (ent.type === 'const') newVars.push(Stack.allocVar());
            else throw new Error(`unsupported conditional branch entry '${ent.type}' in ${spec.mnemonic}`);
          }
          stack.appendToGuardArm(idx, newVars);
        });
        stack.tryFinalizeGuard();
      } else {
        throw new Error(`not supported stack output '${(output as any).type}' while parsing ${spec.mnemonic}`);
      }
    }
    stack.tryFinalizeGuard();

    // Build IR inputs/outputs now
    const inputs: IRInputs = {};
    for (const [name, val] of Object.entries(stackInputs)) {
      const v = val as any as { var: StackVariable; types?: string[] };
      inputs[name] = { id: v.var.name, types: v.types as any } as IRValueRef;
    }
    const outputs: IROutputs = {};
    const outputsSpec = (spec as any)?.value_flow?.outputs?.stack as any[] | undefined;
    const outMap = stackOutputs as any as { [k: string]: { var: StackVariable; types?: string[] } };
    if (outputsSpec && Array.isArray(outputsSpec)) {
      for (const o of outputsSpec) {
        if (o.type === 'simple') {
          const name = o.name as string;
          const v = outMap[name];
          if (v) outputs[name] = { id: v.var.name, types: v.types as any } as IRValueDef;
        } else if (o.type === 'const') {
          // keep any const* in insertion order afterwards
        }
      }
      for (const [name, v] of Object.entries(outMap)) {
        if (!(name in outputs)) outputs[name] = { id: (v as any).var.name, types: (v as any).types as any } as IRValueDef;
      }
    } else {
      for (const [name, val] of Object.entries(stackOutputs)) {
        const v = val as any as { var: StackVariable; types?: string[] };
        outputs[name] = { id: v.var.name, types: v.types as any } as IRValueDef;
      }
    }

    const operandsIR: IROperands = this.convertOperands({ ...operands });
    return { kind: 'prim', spec, mnemonic: spec.mnemonic, inputs, operands: operandsIR, outputs };
  }

  public static lift(slice: Slice, initialStack: StackVariable[] = []): IRFunction {
    const body: IROpPrim[] = [];
    let stack = new Stack(initialStack);
    const args: StackVariable[] = [];
    let decompileError: any = null;
    let disassembleError: any = null;
    const asmTail: { spec: Instruction; operands: IROperands }[] = [];

    while (slice.bits.length > 0) {
      let spec: Instruction;
      let operands: VarMap;
      try {
        [spec, operands] = OpcodeParser.nextInstruction(slice);
        if (CONTINUATIONS[spec.mnemonic] != undefined) {
          for (const operandName of CONTINUATIONS[spec.mnemonic]) {
            const opVal = (operands as any)[operandName];
            (operands as any)[operandName] = Lifter.lift(opVal as Slice);
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
            const op = this.buildOp(spec, operands, stack2);
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
        asmTail.push({ spec, operands: this.convertOperands(operands) });
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
}
