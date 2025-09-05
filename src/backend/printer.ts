import type { Program } from "../core/program";
import { IRFunction, IRInlineExpr, IRInputArg, IRValueDef, IRValueRef, IROpPrim, IROperandValue } from "../core/ir";
import { registerPrinters } from "./stdImpl";
import { Builder } from "ton3-core";

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
  inP: (name: string, side?: 'left' | 'right') => string; // formatted input with precedence-aware parens
  inRaw: (name: string) => IRInputArg | undefined; // raw input by name
  op: (name: string) => string;              // formatted operand by name
  opRaw: (name: string) => IROperandValue | undefined; // raw operand by name
  opInt: (name: string) => number | bigint | undefined; // numeric operand as number/bigint
  opNum: (name: string) => number | undefined;          // numeric operand coerced to JS number if safe
}) => string | null | undefined;

const inlinePrinters = new Map<string, InlinePrinter>();
const inlinePrintersByPrefix: Array<{ prefix: string; printer: InlinePrinter }> = [];

// Statement printers (extensible, like inline printers but allowed to emit multiple lines)
export type StmtPrinter = (st: IROpPrim, ctx: {
  // Existing helpers
  formatInlineOperand: (v: IROperandValue) => string;
  formatInputArg: (a: IRInputArg) => string;
  in: (name: string) => string;
  inP: (name: string, side?: 'left' | 'right') => string;
  inRaw: (name: string) => IRInputArg | undefined;
  outRaw: (name: string) => IRValueDef | undefined;
  op: (name: string) => string;
  opRaw: (name: string) => IROperandValue | undefined;
  opInt: (name: string) => number | bigint | undefined;
  opNum: (name: string) => number | undefined;
  // Aliasing + anchors
  alias: (fromId: string, toId: string) => void;
  ensureSliceAnchor: (sliceIn: IRInputArg | undefined, sliceOut: IRValueDef | undefined) => { anchorId: string; preAssign?: string } | null;
}) => string[] | null | undefined;

const stmtPrinters = new Map<string, StmtPrinter>();
const stmtPrintersByPrefix: Array<{ prefix: string; printer: StmtPrinter }> = [];

export function registerStmtPrinter(mnemonic: string, fn: StmtPrinter) {
  stmtPrinters.set(mnemonic, fn);
}

export function registerStmtPrinterPrefix(prefix: string, fn: StmtPrinter) {
  stmtPrintersByPrefix.push({ prefix, printer: fn });
}

export function registerInlinePrinter(mnemonic: string, fn: InlinePrinter) {
  inlinePrinters.set(mnemonic, fn);
}

export function registerInlinePrinterPrefix(prefix: string, fn: InlinePrinter) {
  inlinePrintersByPrefix.push({ prefix, printer: fn });
}

function formatIR(fn: IRFunction, opts?: { methodId?: number }): string {
  // Operator precedence for selected mnemonics to drive parentheses in inline printing
  // Higher numbers bind tighter.
  const precedenceOf = (m: string): number => {
    // Bitwise OR/XOR/AND
    if (m === 'OR') return 1;
    if (m === 'XOR') return 2;
    if (m === 'AND') return 3;
    // Equality
    if (m === 'EQUAL' || m === 'NEQ' || m === 'EQINT' || m === 'NEQINT') return 4;
    // Relational
    if (m === 'LESS' || m === 'LEQ' || m === 'GREATER' || m === 'GEQ' || m === 'LESSINT' || m === 'GTINT') return 5;
    // Shifts
    if (m === 'LSHIFT' || m === 'RSHIFT' || m === 'RSHIFTR' || m === 'RSHIFTC' ||
        m === 'LSHIFT_VAR' || m === 'RSHIFT_VAR' || m === 'RSHIFTR_VAR' || m === 'RSHIFTC_VAR') return 6;
    // Additive
    if (m === 'ADD' || m === 'SUB' || m === 'INC' || m === 'DEC' || m === 'ADDCONST') return 7;
    // Multiplicative
    if (m === 'MUL' || m === 'DIV' || m === 'MOD' || m === 'MULCONST') return 8;
    // Unary
    if (m === 'NEGATE' || m === 'NOT') return 9;
    return 100; // default: very high, i.e., usually no extra parens
  };
  // Alias map to present some IR vars under a stable pretty-printed name
  // Used to keep a single mutable slice var across consecutive loads
  const varAlias = new Map<string, string>();
  const resolveAlias = (id: string): string => {
    let cur = id;
    const seen = new Set<string>();
    while (varAlias.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = varAlias.get(cur)!;
    }
    return cur;
  };
  const fmtTypes = (t?: IRValueRef['types']) => t && t.length ? `: ${t.join('|')}` : '';
  const fmtValRef = (v: IRValueRef) => `${resolveAlias(v.id)}`;
  const fmtValDef = (v: IRValueDef) => `${v.id}`;

  const formatInlineFn = (f: IRFunction): string => {
    const indentString = (str: string, count: number, indent = " ") => str.replace(/^/gm, indent.repeat(count));
    return indentString(formatIR(f), 4).trimStart();
  };

  const formatInlineMap = (m: Map<number, IRFunction>): string => {
    const entries = [...m.entries()];
    const parts = entries.map(([k, fn]) => `${k}: ${formatInlineFn(fn)}`);
    return `{ ${parts.join(', ')} }`;
  };

  // Per-statement operand → spec-hints mapping for display adjustments
  const operandDisplayHints = new WeakMap<IROperandValue, { hints?: any[]; opType?: string }>();
  const preloadOperandDisplayHints = (st: IROpPrim) => {
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
  };

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
        return (new Builder()).storeSlice(v.value).cell().print().trim();
      }
      case 'cell': {
        return v.value.print().trim();
      }
      case 'other': {
        try { return JSON.stringify(v.value); } catch { return String(v.value); }
      }
    }
  };


  const formatNumber = (n: number): string => {
    if (Number.isInteger(n) && Math.abs(n) <= 512) return String(n);
    if (Number.isInteger(n) && Math.abs(n) % 1000 == 0) return String(n);
    return '0x' + (n >>> 0).toString(16);
  };

  const formatBigInt = (n: bigint): string => {
    const abs = n < 0n ? -n : n;
    if (abs <= 512n) return n.toString();
    if (abs % 1000n == 0n) return n.toString();
    return '0x' + abs.toString(16);
  };

  const formatInlineOpAsExpr = (st: IROpPrim): string => {
    // Preload operand → display_hints map for this instruction
    preloadOperandDisplayHints(st);

    // Custom printer hook first
    const thisPrec = precedenceOf(st.mnemonic);
    const ctx = {
      formatInlineOperand,
      formatInputArg,
      in: (name: string) => {
        const val = st.inputs.find((i) => i.name === name)?.value;
        return val != null ? formatInputArg(val) : '';
      },
      inP: (name: string, _side?: 'left' | 'right') => {
        const val = st.inputs.find((i) => i.name === name)?.value;
        if (!val) return '';
        if ((val as any).kind === 'inline') {
          const child = (val as IRInlineExpr).op;
          const childStr = formatInlineOpAsExpr(child);
          const childPrec = precedenceOf(child.mnemonic);
          const needParens = childPrec <= thisPrec;
          return needParens ? `(${childStr})` : childStr;
        } else {
          return formatInputArg(val);
        }
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

  // (stmt printers registry is module-scoped; see top of file)

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
    // Preload operand display hints for statement-level printers
    preloadOperandDisplayHints(st);

    // Prepare context for statement printers
    const stmtCtx = {
      formatInlineOperand,
      formatInputArg,
      in: (name: string) => {
        const val = st.inputs.find((i) => i.name === name)?.value;
        return val != null ? formatInputArg(val) : '';
      },
      inP: (name: string, _side?: 'left' | 'right') => {
        const thisPrec = precedenceOf(st.mnemonic);
        const val = st.inputs.find((i) => i.name === name)?.value;
        if (!val) return '';
        if ((val as any).kind === 'inline') {
          const child = (val as IRInlineExpr).op;
          const childStr = formatInlineOpAsExpr(child);
          const childPrec = precedenceOf(child.mnemonic);
          const needParens = childPrec <= thisPrec;
          return needParens ? `(${childStr})` : childStr;
        } else {
          return formatInputArg(val);
        }
      },
      inRaw: (name: string) => st.inputs.find((i) => i.name === name)?.value,
      outRaw: (name: string) => st.outputs.find((i) => i.name === name)?.value,
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
      alias: (fromId: string, toId: string) => { varAlias.set(fromId, toId); },
      ensureSliceAnchor: (sliceIn: IRInputArg | undefined, sliceOut: IRValueDef | undefined) => {
        if (!sliceIn || !sliceOut) return null;
        let anchorId: string;
        let preAssign: string | undefined;
        if ((sliceIn as any).kind === 'inline') {
          anchorId = sliceOut.id;
          preAssign = `${anchorId} = ${formatInputArg(sliceIn)}`;
        } else {
          anchorId = fmtValRef(sliceIn as IRValueRef);
        }
        varAlias.set(sliceOut.id, anchorId);
        return { anchorId, preAssign };
      },
    } as const;

    // Try statement printers by exact mnemonic and by prefix
    const stmtHook = stmtPrinters.get(st.mnemonic) ?? stmtPrintersByPrefix.find(x => st.mnemonic.startsWith(x.prefix))?.printer;
    if (stmtHook) {
      const lines = stmtHook(st, stmtCtx);
      if (lines && lines.length) {
        for (const l of lines) {
          // Allow statement printers to emit multi-line blocks without forced semicolons
          if (l.includes('\n')) {
            const indented = l.split('\n').map(part => `    ${part}`).join('\n');
            out += `${indented}\n`;
          } else {
            out += `    ${l};\n`;
          }
        }
        continue;
      }
    }

    // Default formatting
    const outs = st.outputs.map(o => fmtValDef(o.value)).join(', ');
    const expr = formatInlineOpAsExpr(st);
    out += `    ${outs ? outs + ' = ' : ''}${expr};\n`;
  }
  if (fn.result.length) {
    out += `    return ${fn.result.map(v => `${fmtValRef(v)}${fmtTypes(v.types)}`).join(', ')}\n`;
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

registerPrinters();
