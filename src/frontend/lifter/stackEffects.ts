import type { Instruction } from "../../gen/tvm-spec";
import type { VarMap } from "../../disasm";
import { Stack, StackVariable } from "../../stackAnalysis";
import type { IRInputs, IROperands, IROpPrim, IROutputs, IRValueDef, IRValueRef } from "../../core/ir";
import { convertOperands } from "./operands";

function isStackOp(spec: Instruction): boolean {
  return ["stack_basic", "stack_complex"].includes(spec.doc.category);
}

// Consume stack inputs according to spec and return mapping name -> { var, types }
function collectStackInputs(spec: Instruction, operands: VarMap, stack: Stack): { [k: string]: { var: StackVariable; types?: string[] } } {
  if (!spec.value_flow || !spec.value_flow.inputs || !spec.value_flow.inputs.stack) {
    throw new Error(`Unconstrained stack input while parsing ${spec.mnemonic}`);
  }
  const stackInputs: { [k: string]: { var: StackVariable; types?: string[] } } = {};
  // Inputs described deepest->top in spec; we pop from top
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
  return stackInputs;
}

// Allocate stack outputs according to spec; may create conditional guard
function allocateStackOutputs(spec: Instruction, operands: VarMap, stack: Stack): { stackOutputs: { [k: string]: { var: StackVariable; types?: string[] } } } {
  if (!spec.value_flow || !spec.value_flow.outputs || !spec.value_flow.outputs.stack) {
    throw new Error(`Unconstrained stack output while parsing ${spec.mnemonic}`);
  }

  const stackOutputs: { [k: string]: { var: StackVariable; types?: string[] } } = {};
  let constCounter = 0;
  let pushedThisInsn = 0;
  let condOutCounter = 0; // running index for synthesized conditional outputs

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
      // Try to finalize guard progressively in case this instruction aligns it fully
      const mergedNow = stack.tryFinalizeGuard();
      if (mergedNow && mergedNow.length) {
        for (const v of mergedNow) {
          const name = `__cond${condOutCounter++}`;
          stackOutputs[name] = { var: v, types: [] };
        }
      }
    } else {
      throw new Error(`not supported stack output '${(output as any).type}' while parsing ${spec.mnemonic}`);
    }
  }
  // If guard was finalized by this instruction, collect merged variables and expose them as outputs too
  const merged = stack.tryFinalizeGuard();
  if (merged && merged.length) {
    for (const v of merged) {
      const name = `__cond${condOutCounter++}`;
      stackOutputs[name] = { var: v, types: [] };
    }
  }

  return { stackOutputs };
}

// Convert raw stack var maps to IR ports ordered by spec
function mapIRPorts(
  stackInputs: { [k: string]: { var: StackVariable; types?: string[] } },
  stackOutputs: { [k: string]: { var: StackVariable; types?: string[] } },
  spec: Instruction,
): { inputs: IRInputs; outputs: IROutputs } {
  const inputs: IRInputs = [];
  for (const [name, val] of Object.entries(stackInputs)) {
    inputs.push({ name, value: { id: val.var.name, types: val.types as any } as IRValueRef });
  }

  const outputs: IROutputs = [];
  const outputsSpec = (spec as any)?.value_flow?.outputs?.stack as any[] | undefined;
  const outMap = stackOutputs as any as { [k: string]: { var: StackVariable; types?: string[] } };
  if (outputsSpec && Array.isArray(outputsSpec)) {
    // Emit conditional outputs in spec order using synthesized names (__cond0, __cond1, ...)
    let condIdx = 0;
    for (const o of outputsSpec) {
      if (o.type === 'conditional') {
        const name = `__cond${condIdx++}`;
        // debug: check presence
        // console.log('mapIRPorts conditional pick', spec.mnemonic, name, !!outMap[name]);
        const v = outMap[name];
        if (v) outputs.push({ name, value: { id: v.var.name, types: v.types as any } as IRValueDef });
      } else if (o.type === 'simple') {
        const name = o.name as string;
        const v = outMap[name];
        if (v) outputs.push({ name, value: { id: v.var.name, types: v.types as any } as IRValueDef });
      } else if (o.type === 'const') {
        // We'll append const* in insertion order afterwards
      }
    }
    for (const [name, v] of Object.entries(outMap)) {
      if (!outputs.find((x) => x.name === name)) {
        outputs.push({ name, value: { id: (v as any).var.name, types: (v as any).types as any } as IRValueDef });
      }
    }
  } else {
    for (const [name, val] of Object.entries(stackOutputs)) {
      outputs.push({ name, value: { id: val.var.name, types: val.types as any } as IRValueDef });
    }
  }
  return { inputs, outputs };
}

// Build and apply stack effects, return IROpPrim or null (for raw stack ops)
export function buildOp(spec: Instruction, operands: VarMap, stack: Stack): IROpPrim | null {
  if (isStackOp(spec)) {
    stack.execStackInstruction(spec, operands);
    return null;
  }
  if (!spec.value_flow || !spec.value_flow.inputs || !spec.value_flow.outputs) {
    throw new Error(`instruction is missing value flow: ${spec.mnemonic}`);
  }

  const stackInputs = collectStackInputs(spec, operands, stack);
  const { stackOutputs } = allocateStackOutputs(spec, operands, stack);
  stack.tryFinalizeGuard();

  const { inputs, outputs } = mapIRPorts(stackInputs, stackOutputs, spec);
  const operandsIR: IROperands = convertOperands({ ...operands });
  return { kind: 'prim', spec, mnemonic: spec.mnemonic, inputs, operands: operandsIR, outputs };
}
