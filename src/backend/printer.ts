import type { Program } from "../core/program";
import { IRFunction, IRInlineExpr, IRInputArg, IRValueDef, IRValueRef, IROpPrim, IROperandValue } from "../core/ir";

// Pretty printer for IR → textual pseudocode
export function printIR(fn: IRFunction, opts?: { methodId?: number }): string {
  return formatIR(fn, opts);
}

// Extension point: custom inline printers per instruction mnemonic
// Return string to override default formatting of an inline op expression
export type InlinePrinter = (st: IROpPrim, ctx: {
  formatInlineOperand: (v: IROperandValue) => string;
  formatInputArg: (a: IRInputArg) => string;
}) => string | null | undefined;

const inlinePrinters = new Map<string, InlinePrinter>();
const inlinePrintersByPrefix: Array<{ prefix: string; printer: InlinePrinter }> = [];

export function registerInlinePrinter(mnemonic: string, fn: InlinePrinter) {
  inlinePrinters.set(mnemonic, fn);
}

export function registerInlinePrinterPrefix(prefix: string, fn: InlinePrinter) {
  inlinePrintersByPrefix.push({ prefix, printer: fn });
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
    switch (v.kind) {
      case 'cont': return formatInlineFn(v.value);
      case 'cont_map': return formatInlineMap(v.value);
      case 'int': return formatNumber(v.value);
      case 'bigint': return formatBigInt(v.value);
      case 'bool': return String(v.value);
      case 'slice': {
        try { return String(v.value); } catch { return '[slice]'; }
      }
      case 'cell': {
        try { return String(v.value); } catch { return '[cell]'; }
      }
      case 'other': {
        try { return JSON.stringify(v.value); } catch { return String(v.value); }
      }
    }
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
    // Custom printer hook first
    const hook = inlinePrinters.get(st.mnemonic);
    if (hook) {
      const res = hook(st, { formatInlineOperand, formatInputArg });
      if (res != null) return res;
    }
    for (const { prefix, printer } of inlinePrintersByPrefix) {
      if (st.mnemonic.startsWith(prefix)) {
        const res = printer(st, { formatInlineOperand, formatInputArg });
        if (res != null) return res;
      }
    }

    const insOrder = st.inputs.map(({ name, value }) => `${name}=${formatInputArg(value)}`).join(', ');
    const opPairs = st.operands.map(({ name, value }) => [name, formatInlineOperand(value as IROperandValue)] as [string, string]);
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
    const outs = st.outputs.map(o => fmtValDef(o.value)).join(', ');
    const expr = formatInlineOpAsExpr(st);
    // If multi-line, expr ends with a closing ')' at correct indent
    out += `    ${outs ? outs + ' = ' : ''}${expr};\n`;
  }
  if (fn.result.length) {
    out += `    // result: ${fn.result.map(v => `${v.id}${fmtTypes(v.types)}`).join(', ')}\n`;
  }
  if (fn.decompileError) out += `    // decompilation error: ${fn.decompileError}\n`;
  if (fn.asmTail && fn.asmTail.length) {
    for (const ins of fn.asmTail) {
      const ops = ins.operands.map(({ name, value }) => `${name}=${formatInlineOperand(value as IROperandValue)}`).join(', ');
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

// Default custom printers
// Collapse PUSHINT_* wrappers used as inline operands into bare literals
registerInlinePrinterPrefix('PUSHINT_', (st, ctx) => {
  const vx = st.operands.find(o => o.name === 'x')?.value;
  const vi = st.operands.find(o => o.name === 'i')?.value;
  const v = vx ?? vi;
  if (v == null) return null;
  return ctx.formatInlineOperand(v);
});

registerInlinePrinter('PUSHCTR', (st, _) => {
  const i = st.operands.find(o => o.name === 'i')?.value.value;
  if (i === 4) {
    return "get_data()";
  }
});

registerInlinePrinter('POPCTR', (st, ctx) => {
  const i = st.operands.find(o => o.name === 'i')?.value.value;
  if (i === 4) {
    return `set_data(${ctx.formatInputArg(st.inputs.find(i => i.name === 'x')!.value)})`;
  }
});

registerInlinePrinter('CTOS', (st, ctx) => {
  return `${ctx.formatInputArg(st.inputs.find(i => i.name === 'c')!.value)}.begin_parse()`;
});

registerInlinePrinter('PLDU', (st, ctx) => {
  return `${ctx.formatInputArg(st.inputs.find(i => i.name === 's')!.value)}.preload_uint(${ctx.formatInlineOperand(st.operands.find(o => o.name === 'c')!.value)})`;
});

registerInlinePrinter('NEWC', (_st, _ctx) => {
  return "begin_cell()";
});

registerInlinePrinter('SDSKIPFIRST', (st, ctx) => {
  return `${ctx.formatInputArg(st.inputs.find(i => i.name === 's')!.value)}.skip_bits(${ctx.formatInputArg(st.inputs.find(o => o.name === 'l')!.value)})`;
});