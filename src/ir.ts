import type { Instruction, PossibleValueTypes } from "./gen/tvm-spec";
import type { Slice, Cell, Hashmap } from "ton3-core";

// Intermediate Representation (IR) to describe decompiled code in a
// transformation-friendly way. Optimizers can operate on this IR and
// a later pretty-printer can render textual output.

export type IRType = PossibleValueTypes[number]; // e.g. 'Integer' | 'Cell' | ...

export type IRValueId = string; // uses existing stack variable ids like 'arg0', 'var3'

export type IRValueRef = {
  id: IRValueId;
  types?: IRType[]; // type hints from spec
};

export type IRValueDef = {
  id: IRValueId;
  types?: IRType[];
};

export type IROperandValue = number | bigint | boolean | Slice | Cell | IRFunction | Map<number, IRFunction> | unknown;

export type IROperands = { [name: string]: IROperandValue };

export type IRInputs = { [name: string]: IRValueRef };

export type IROutputs = { [name: string]: IRValueDef };

export type IROpPrim = {
  kind: 'prim';
  spec: Instruction; // full instruction spec for semantics
  mnemonic: string;   // cached for convenience
  inputs: IRInputs;   // stack inputs consumed by this op
  operands: IROperands; // immediate operands (non-stack)
  outputs: IROutputs; // stack outputs produced by this op
};

export type IRStmt = IROpPrim;

export type IRFunction = {
  kind: 'function';
  // Formal parameters (top-of-stack last as in decompiler args order)
  args: IRValueDef[];
  // Linear body (we can attach CFG later if needed)
  body: IRStmt[];
  // Resulting stack values after executing the body
  result: IRValueRef[];
  // Optional tails and errors preserved for diagnostics
  asmTail?: { spec: Instruction; operands: IROperands }[];
  tailSliceInfo?: string; // textual form of tail slice for debug only
  decompileError?: string | null;
  disassembleError?: string | null;
};

export function isIRFunction(x: unknown): x is IRFunction {
  return !!x && typeof x === 'object' && (x as any).kind === 'function';
}

// Minimal IR pretty-printer for debugging and evaluation.
export function formatIR(fn: IRFunction): string {
  const indent = (s: string, n: number) => s.replace(/^/gm, ' '.repeat(n));
  const fmtTypes = (t?: IRType[]) => t && t.length ? `: ${t.join('|')}` : '';
  const fmtValRef = (v: IRValueRef) => `${v.id}${fmtTypes(v.types)}`;
  const fmtValDef = (v: IRValueDef) => `${v.id}${fmtTypes(v.types)}`;

  // Inlined formatter for continuation operands – full body (debug-friendly)
  const formatInlineFn = (f: IRFunction): string => {
    return formatIR(f);
  };

  const formatInlineMap = (m: Map<number, IRFunction>): string => {
    const entries = [...m.entries()];
    const parts = entries.map(([k, fn]) => `${k}: ${formatInlineFn(fn)}`);
    return `{ ${parts.join(', ')} }`;
  };

  const formatInlineOperand = (v: IROperandValue): string => {
    if (isIRFunction(v)) return formatInlineFn(v);
    if (v instanceof Map) return formatInlineMap(v as Map<number, IRFunction>);
    if (typeof v === 'object' && v !== null) {
      // Slice/Cell or other object: fall back to toString()
      try { return String(v); } catch { return '[object]'; }
    }
    return JSON.stringify(v);
  };

  const args = fn.args.map(a => fmtValDef(a)).join(', ');
  let out = `function (${args}) {\n`;
  for (const st of fn.body) {
    const outs = Object.values(st.outputs).map(fmtValDef).join(', ');
    const insOrder = Object.entries(st.inputs).map(([k, v]) => `${k}=${fmtValRef(v)}`).join(', ');
    const opPairs = Object.entries(st.operands).map(([k, v]) => [k, formatInlineOperand(v)] as [string, string]);
    const hasMultiline = opPairs.some(([, v]) => v.includes('\n'));

    if (!hasMultiline) {
      const ops = opPairs.map(([k, v]) => `${k}=${v}`).join(', ');
      const parts = [insOrder, ops].filter(Boolean).join(' | ');
      out += `    ${outs ? outs + ' = ' : ''}${st.mnemonic}(${parts});\n`;
    } else {
      out += `    ${outs ? outs + ' = ' : ''}${st.mnemonic}(` + '\n';
      const indent8 = '        ';
      if (insOrder) {
        out += indent8 + insOrder + (opPairs.length ? ' |' : '') + '\n';
      }
      for (let i = 0; i < opPairs.length; i++) {
        const [k, v] = opPairs[i];
        const lines = v.split('\n');
        out += indent8 + k + '=' + lines[0] + (i < opPairs.length - 1 ? ',' : '') + '\n';
        for (let j = 1; j < lines.length; j++) {
          out += indent8 + ' '.repeat(k.length + 1) + lines[j] + (i < opPairs.length - 1 && j === lines.length - 1 ? ',' : '') + '\n';
        }
      }
      out += `    );\n`;
    }
  }
  if (fn.result.length) {
    out += `    // result: ${fn.result.map(fmtValRef).join(', ')}\n`;
  }
  if (fn.decompileError) out += `    // decompilation error: ${fn.decompileError}\n`;
  if (fn.asmTail && fn.asmTail.length) {
    for (const ins of fn.asmTail) {
      const ops = Object.entries(ins.operands).map(([k, v]) => `${k}=${formatInlineOperand(v)}`).join(', ');
      out += `    ${ins.spec.mnemonic} ${ops}\n`;
    }
  }
  if (fn.disassembleError) out += `    // disassemble error: ${fn.disassembleError}\n`;
  if (fn.tailSliceInfo) {
    out += `    // tail slice: ${fn.tailSliceInfo}\n`;
  }
  out += `}`;
  return out;
}
