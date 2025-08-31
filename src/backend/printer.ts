import type { Program } from "../core/program";
import { IRFunction, IRInlineExpr, IRInputArg, IRValueDef, IRValueRef, IROpPrim, IROperandValue } from "../core/ir";

// Pretty printer for IR → textual pseudocode
export function printIR(fn: IRFunction, opts?: { methodId?: number }): string {
  return formatIR(fn, opts);
}

// Extension point: custom inline printers per instruction mnemonic
// Return string to override default formatting of an inline op expression
export type InlinePrinter = (st: IROpPrim, ctx: {
  // Low-level formatters (existing)
  formatInlineOperand: (v: IROperandValue) => string;
  formatInputArg: (a: IRInputArg) => string;
  // Convenience helpers (new)
  in: (name: string) => string;              // formatted input by name
  inRaw: (name: string) => IRInputArg | undefined; // raw input by name
  op: (name: string) => string;              // formatted operand by name
  opRaw: (name: string) => IROperandValue | undefined; // raw operand by name
  opInt: (name: string) => number | bigint | undefined; // numeric operand as number/bigint
  opNum: (name: string) => number | undefined;          // numeric operand coerced to JS number if safe
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
  const fmtValRef = (v: IRValueRef) => `${v.id}`;
  const fmtValDef = (v: IRValueDef) => `${v.id}${fmtTypes(v.types)}`;

  const formatInlineFn = (f: IRFunction): string => {
    return formatIR(f);
  };

  const formatInlineMap = (m: Map<number, IRFunction>): string => {
    const entries = [...m.entries()];
    const parts = entries.map(([k, fn]) => `${k}: ${formatInlineFn(fn)}`);
    return `{ ${parts.join(', ')} }`;
  };

  // Per-statement operand → spec-hints mapping for display adjustments
  const operandDisplayHints = new WeakMap<IROperandValue, { hints?: any[]; opType?: string }>();

  const applyDisplayHintsNumber = (n: number, hints?: any[]): { text?: string; value: number } => {
    if (!hints || hints.length === 0) return { value: n };
    let v = n;
    let mode: 'stack' | 'register' | null = null;
    for (const h of hints) {
      if (!h || typeof h !== 'object') continue;
      const t = (h as any).type;
      if (t === 'add') {
        const delta = Number((h as any).value ?? 0);
        if (Number.isFinite(delta)) v = v + delta;
      } else if (t === 'pushint4') {
        if (v > 10) v = v - 16;
      } else if (t === 'optional_nargs') {
        if (v === 15) v = -1;
      } else if (t === 'plduz') {
        v = 32 * (v + 1);
      } else if (t === 'stack') {
        mode = 'stack';
      } else if (t === 'register') {
        mode = 'register';
      }
    }
    if (mode === 'stack') return { text: `s${v}`, value: v };
    if (mode === 'register') return { text: `c${v}`, value: v };
    return { value: v };
  };

  const applyDisplayHintsBigInt = (n: bigint, hints?: any[]): { text?: string; value: bigint } => {
    if (!hints || hints.length === 0) return { value: n };
    let v = n;
    let mode: 'stack' | 'register' | null = null;
    for (const h of hints) {
      if (!h || typeof h !== 'object') continue;
      const t = (h as any).type;
      if (t === 'add') {
        const delta = BigInt(Number((h as any).value ?? 0));
        v = v + delta;
      } else if (t === 'pushint4') {
        if (v > 10n) v = v - 16n;
      } else if (t === 'optional_nargs') {
        if (v === 15n) v = -1n;
      } else if (t === 'plduz') {
        v = 32n * (v + 1n);
      } else if (t === 'stack') {
        mode = 'stack';
      } else if (t === 'register') {
        mode = 'register';
      }
    }
    if (mode === 'stack') return { text: `s${v.toString()}`, value: v };
    if (mode === 'register') return { text: `c${v.toString()}`, value: v };
    return { value: v };
  };

  const formatInlineOperand = (v: IROperandValue): string => {
    const hintsInfo = operandDisplayHints.get(v);
    const hints = hintsInfo?.hints;
    switch (v.kind) {
      case 'cont': return formatInlineFn(v.value);
      case 'cont_map': return formatInlineMap(v.value);
      case 'int': {
        const adj = applyDisplayHintsNumber(v.value, hints);
        if (adj.text) return adj.text;
        return formatNumber(adj.value);
      }
      case 'bigint': {
        const adj = applyDisplayHintsBigInt(v.value, hints);
        if (adj.text) return adj.text;
        return formatBigInt(adj.value);
      }
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
    // Preload operand → display_hints map for this instruction
    try {
      const opsSpec: any[] | undefined = (st as any)?.spec?.bytecode?.operands;
      if (Array.isArray(opsSpec)) {
        for (const { name, value } of st.operands) {
          const specEnt = opsSpec.find((o) => o && o.name === name);
          if (specEnt) {
            operandDisplayHints.set(value as IROperandValue, { hints: specEnt.display_hints, opType: specEnt.type });
          }
        }
      }
    } catch {}

    // Custom printer hook first
    const ctx = {
      formatInlineOperand,
      formatInputArg,
      in: (name: string) => {
        const val = st.inputs.find((i) => i.name === name)?.value;
        return val != null ? formatInputArg(val) : '';
      },
      inRaw: (name: string) => st.inputs.find((i) => i.name === name)?.value,
      op: (name: string) => {
        const val = st.operands.find((o) => o.name === name)?.value as IROperandValue | undefined;
        return val != null ? formatInlineOperand(val) : '';
      },
      opRaw: (name: string) => st.operands.find((o) => o.name === name)?.value as IROperandValue | undefined,
      opInt: (name: string) => {
        const v = st.operands.find((o) => o.name === name)?.value as IROperandValue | undefined;
        if (!v) return undefined;
        if (v.kind === 'int') return v.value;
        if (v.kind === 'bigint') return v.value;
        return undefined;
      },
      opNum: (name: string) => {
        const v = st.operands.find((o) => o.name === name)?.value as IROperandValue | undefined;
        if (!v) return undefined;
        if (v.kind === 'int') return v.value;
        if (v.kind === 'bigint') {
          const asNum = Number(v.value);
          return Number.isFinite(asNum) ? asNum : undefined;
        }
        return undefined;
      },
    } as const;

    const hook = inlinePrinters.get(st.mnemonic);
    if (hook) {
      const res = hook(st, ctx);
      if (res != null) return res;
    }
    for (const { prefix, printer } of inlinePrintersByPrefix) {
      if (st.mnemonic.startsWith(prefix)) {
        const res = printer(st, ctx);
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
      // Preload display_hints mapping for tail instructions as well
      try {
        const opsSpec: any[] | undefined = (ins as any)?.spec?.bytecode?.operands;
        if (Array.isArray(opsSpec)) {
          for (const { name, value } of ins.operands) {
            const specEnt = opsSpec.find((o) => o && o.name === name);
            if (specEnt) {
              operandDisplayHints.set(value as IROperandValue, { hints: specEnt.display_hints, opType: specEnt.type });
            }
          }
        }
      } catch {}
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
registerInlinePrinterPrefix('PUSHINT_', (_st, ctx) => {
  const v = ctx.opRaw('x') ?? ctx.opRaw('i');
  if (v == null) return null;
  return ctx.formatInlineOperand(v);
});

registerInlinePrinter('PUSHCTR', (_st, ctx) => {
  if (ctx.opNum('i') === 4) {
    return "get_data()";
  }
});

registerInlinePrinter('POPCTR', (_st, ctx) => {
  if (ctx.opNum('i') === 4) {
    return `set_data(${ctx.in('x')})`;
  }
});

registerInlinePrinter('CTOS', (_st, ctx) => {
  return `${ctx.in('c')}.begin_parse()`;
});

registerInlinePrinter('PLDU', (_st, ctx) => {
  return `${ctx.in('s')}.preload_uint(${ctx.op('c')})`;
});

registerInlinePrinter('PLDI', (_st, ctx) => {
  return `${ctx.in('s')}.preload_uint(${ctx.op('c')})`;
});

registerInlinePrinter('STU', (_st, ctx) => {
  return `${ctx.in('b')}.store_uint(${ctx.in('x')}, ${ctx.op('c')})`;
});

registerInlinePrinter('STI', (_st, ctx) => {
  return `${ctx.in('b')}.store_int(${ctx.in('x')}, ${ctx.op('c')})`;
});

registerInlinePrinter('STDICT', (_st, ctx) => {
  return `${ctx.in('b')}.store_dict(${ctx.in('D')}, ${ctx.op('c')})`;
});

registerInlinePrinter('STSLICER', (_st, ctx) => {
  return `${ctx.in('b')}.store_slice(${ctx.in('s')})`;
});

registerInlinePrinter('SDCUTFIRST', (_st, ctx) => {
  return `${ctx.in('s')}.first_bits(${ctx.in('l')})`;
});

registerInlinePrinter('NEWC', (_st, _ctx) => {
  return "begin_cell()";
});

registerInlinePrinter('ENDC', (_st, ctx) => {
  return `${ctx.in('b')}.end_cell()`;
});

registerInlinePrinter('EQUAL', (_st, ctx) => {
  return `${ctx.in('x')} == ${ctx.in('y')}`;
});

registerInlinePrinter('INC', (_st, ctx) => {
  return `${ctx.in('x')} + 1`;
});

registerInlinePrinter('SDSKIPFIRST', (_st, ctx) => {
  return `${ctx.in('s')}.skip_bits(${ctx.in('l')})`;
});
