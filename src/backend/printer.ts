import type { Program } from "../core/program";
import { IRFunction, IRInlineExpr, IRInputArg, IRValueDef, IRValueRef, IROpPrim, IROperandValue } from "../core/ir";

// Pretty printer for IR → textual pseudocode
export function printIR(fn: IRFunction, opts?: { methodId?: number }): string {
  return formatIR(fn, opts);
}

function formatIR(fn: IRFunction, opts?: { methodId?: number }): string {
  const fmtTypes = (t?: IRValueRef['types']) => t && t.length ? `: ${t.join('|')}` : '';
  const fmtValRef = (v: IRValueRef) => `${v.id}${fmtTypes(v.types)} `;
  const fmtValDef = (v: IRValueDef) => `${v.id}${fmtTypes(v.types)}`;

  const formatInlineFn = (f: IRFunction): string => {
    return formatIR(f);
  };

  const formatInlineMap = (m: Map<number, IRFunction>): string => {
    const entries = [...m.entries()];
    const parts = entries.map(([k, fn]) => `${k}: ${formatInlineFn(fn)}`);
    return `{ ${parts.join(', ')} }`;
  };

  const formatInlineOperand = (v: IROperandValue): string => {
    if ((v as any)?.kind === 'function') return formatInlineFn(v as unknown as IRFunction);
    if (v instanceof Map) return formatInlineMap(v as Map<number, IRFunction>);
    if (typeof v === 'object' && v !== null) {
      try { return String(v); } catch { return '[object]'; }
    }
    if (typeof v === 'number') return formatNumber(v);
    if (typeof v === 'bigint') return formatBigInt(v);
    return JSON.stringify(v);
  };

  const formatNumber = (n: number): string => {
    if (Number.isInteger(n) && Math.abs(n) <= 512) return String(n);
    const hex = '0x' + (n >>> 0).toString(16);
    return `${n} (${hex})`;
  };

  const formatBigInt = (n: bigint): string => {
    const abs = n < 0n ? -n : n;
    if (abs <= 512n) return n.toString();
    const hex = '0x' + abs.toString(16);
    return n.toString() + ' (' + hex + ')';
  };

  const formatInlineOpAsExpr = (st: IROpPrim): string => {
    const insOrder = Object.entries(st.inputs).map(([k, v]) => `${k}=${formatInputArg(v)}`).join(', ');
    const opPairs = Object.entries(st.operands).map(([k, v]) => [k, formatInlineOperand(v)] as [string, string]);
    const hasMultiline = opPairs.some(([, v]) => v.includes('\n'));

    if (!hasMultiline) {
      const ops = opPairs.map(([k, v]) => `${k}=${v}`).join(', ');
      const parts = [insOrder, ops].filter(Boolean).join(' | ');
      return `${st.mnemonic}(${parts})`;
    } else {
      let out = `${st.mnemonic}(` + '\n';
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
      out += `    )`;
      return out;
    }
  };

  const formatInputArg = (a: IRInputArg): string => {
    if ((a as any).kind === 'inline') {
      return formatInlineOpAsExpr((a as IRInlineExpr).op);
    }
    return fmtValRef(a as IRValueRef);
  };

  const argsStr = fn.args.map(a => fmtValDef(a)).join(', ');
  const nameFromMethodId = (id?: number) => {
    if (id === -1) return 'recv_external';
    if (id === 0) return 'recv_internal';
    return undefined;
  };
  const nameStr = fn.name ? ` ${fn.name}` : (opts?.methodId !== undefined ? (nameFromMethodId(opts.methodId) ? ` ${nameFromMethodId(opts.methodId)}` : '') : '');
  const header = opts?.methodId !== undefined ? `/* methodId: ${opts.methodId} */\n` : '';
  let out = header + `function${nameStr} (${argsStr}) {\n`;
  for (const st of fn.body) {
    const getOutputsInOrder = (): IRValueDef[] => {
      const vf: any = (st as any).spec?.value_flow;
      const specStack = vf?.outputs?.stack as any[] | undefined;
      if (!specStack) return Object.values(st.outputs);
      const entries = Object.entries(st.outputs) as [string, IRValueDef][];
      const byName = new Map(entries);
      const constKeys: string[] = entries.filter(([k]) => k.startsWith('const')).map(([k]) => k);
      const used = new Set<string>();
      const ordered: IRValueDef[] = [];
      for (const out of specStack) {
        if ((out as any).type === 'simple') {
          const k = (out as any).name as string;
          const v = byName.get(k);
          if (v) { ordered.push(v as IRValueDef); used.add(k); }
        } else if ((out as any).type === 'const') {
          const k = constKeys.find((x) => !used.has(x));
          if (k) { ordered.push(byName.get(k)!); used.add(k); }
        }
      }
      for (const [k, v] of entries) {
        if (!used.has(k)) ordered.push(v);
      }
      return ordered;
    };

    const outs = getOutputsInOrder().map(fmtValDef).join(', ');
    const insOrder = Object.entries(st.inputs).map(([k, v]) => `${k}=${formatInputArg(v)}`).join(', ');
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
    out += `    // result: ${fn.result.map(v => `${v.id}${fmtTypes(v.types)}`).join(', ')}\n`;
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
