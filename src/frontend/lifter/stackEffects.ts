import type { Instruction } from "../../gen/tvm-spec";
import type { VarMap } from "../../disasm";
import { Stack, StackVariable } from "../../stackAnalysis";
import { IRValueRef, type IRFunction, type IRInputs, type IROperands, type IROpPrim, type IROutputs, type IRValueDef } from "../../core/ir";
import { convertOperands } from "./operands";

function isStackOp(spec: Instruction): boolean {
  return ["stack_basic", "stack_complex"].includes(spec.doc.category);
}

// Consume stack inputs according to spec and return mapping name -> { var, types }
function collectStackInputs(spec: Instruction, operands: VarMap, stack: Stack): IRInputs {
  if (!spec.value_flow || !spec.value_flow.inputs || !spec.value_flow.inputs.stack) {
    throw new Error(`Unconstrained stack input while parsing ${spec.mnemonic}`);
  }
  const stackInputs: IRInputs = [];
  // Inputs described deepest->top in spec; we pop from top
  for (const input of spec.value_flow.inputs.stack.slice().reverse()) {
    if (input.type === 'simple') {
      const v = stack.pop();
      stackInputs.push({ name: input.name, value: { id: v.name, types: input.value_types, continuationMeta: v.continuationMeta } });
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
            stackInputs.push({ name: `${ent.name}${idx}`, value: { id: v.name, types: ent.value_types } });
            idx++;
          } else if (ent.type === 'const') {
            const v = stack.pop();
            stackInputs.push({ name: `const_in_${idx}`, value: { id: v.name, types: [ent.value_type] } });
            idx++;
          } else if (ent.type === 'conditional' || ent.type === 'array') {
            throw new Error(`not supported nested '${ent.type}' inside array input while parsing ${spec.mnemonic}`);
          }
        }
      }
    } else {
      throw new Error(`not supported stack input '${input.type}' while parsing ${spec.mnemonic}`);
    }
  }
  return stackInputs;
}

// Allocate stack outputs according to spec; may create conditional guard
function allocateStackOutputs(spec: Instruction, operands: VarMap, stack: Stack): IROutputs {
  if (!spec.value_flow || !spec.value_flow.outputs || !spec.value_flow.outputs.stack) {
    throw new Error(`Unconstrained stack output while parsing ${spec.mnemonic}`);
  }

  let stackOutputs: IROutputs = [];
  let constCounter = 0;
  let pushedThisInsn = 0;
  let condOutCounter = 0; // running index for synthesized conditional outputs

  for (const output of spec.value_flow.outputs.stack) {
    if (output.type === 'simple') {
      const v = stack.push();
      if (spec.mnemonic == 'PUSHCONT_SHORT' || spec.mnemonic == 'PUSHCONT') {
        v.continuationMeta = { continuation: operands['s'] };
      }
      pushedThisInsn += 1;
      stackOutputs.push({ name: output.name, value: { id: v.name, types: output.value_types } });
    } else if (output.type === 'const') {
      const v = stack.push();
      pushedThisInsn += 1;
      stackOutputs.push({ name: `const${constCounter++}`, value: { id: v.name, types: [output.value_type] } });
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
            stackOutputs.push({ name: key, value: { id: v.name, types: ent.value_types } });
            idx++;
          } else if (ent.type === 'const') {
            const v = stack.push();
            pushedThisInsn += 1;
            const key = `const${constCounter++}`;
            stackOutputs.push({ name: key, value: { id: v.name, types: [ent.value_type] } });
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
          stackOutputs.push({ name: name, value: { id: v.name, types: [] } });
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
      stackOutputs.push({ name: name, value: { id: v.name, types: [] } });
    }
  }

  return stackOutputs;
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

  const inputs = collectStackInputs(spec, operands, stack);
  const { inputs: controlFlowInputs, outputs: controlFlowOutputs } = analyzeControlFlow(spec, operands, stack, inputs);
  const outputs = allocateStackOutputs(spec, operands, stack);
  stack.tryFinalizeGuard();
  const operandsIR: IROperands = convertOperands({ ...operands });
  return { kind: 'prim', spec, mnemonic: spec.mnemonic, inputs: [...inputs, ...controlFlowInputs], operands: operandsIR, outputs: [...outputs, ...controlFlowOutputs] };
}

export interface BranchInfo {
  varName: string;
  target: IRFunction;
  args: { outer: StackVariable, inner: IRValueDef }[];
  parentPop: number;
  parentPush: number;
}

export function analyzeControlFlow(spec: Instruction, operands: VarMap, stack: Stack, stackInputs: IRInputs): { inputs: IRInputs, outputs: IROutputs } {
  let inputs: IRInputs = [];
  let maxRets = -1;
  let maxArgs = 0;
  let hasJumps = false;
  for (let i = 0; i < spec.control_flow.branches.length; i++) {
    const branch = spec.control_flow.branches[i];
    if (branch.type == 'variable') {
      const varName = branch.var_name;
      let target: IRFunction | undefined = operands[varName];
      if (!target) {
        const contInput = stackInputs.find(i => i.name == varName);
        if (!contInput) {
          throw new Error('no such input');
        }
        const value = contInput.value as IRValueRef;
        if (value.continuationMeta == undefined) {
          throw new Error('continuation has no meta!');
        }
        target = value.continuationMeta.continuation;
      }
      
      const stackCopy = stack.copy();
      for (const arg of target.args.slice().reverse()) {
        const v = stackCopy.pop();
        inputs.push({ name: varName + '_' + arg.id, value: { id: v.name } });
      }
      if (maxRets != -1 && maxArgs - maxRets != target.args.length - target.result.length) {
        throw new Error(`bad branch ${varName} with ${target.args.length} args and ${target.result.length}`);
      }
      if (target.args.length > maxArgs) {
        maxArgs = target.args.length;
        maxRets = target.result.length;
      }
      if (branch.save?.c0?.type != "cc") {
        hasJumps = true;
      }
    }
  }
  if (hasJumps || maxRets == -1) {
    maxRets = 0;
  }
  if (spec.control_flow.nobranch && maxArgs != maxRets && !hasJumps) {
    throw new Error(`for nobranch, args=${maxArgs} must be same as rets=${maxRets}`);
  }
  for (let i = 0; i < maxArgs; i++) {
    stack.pop();
  }
  const outputs = (new Array(maxRets)).fill(undefined).map((_, i) => {
    const v = stack.push();
    return { name: `out_${i}`, value: { id: v.name } };
  });
  return { inputs, outputs };
}