// Stdlib-friendly printers for TVM instructions.
// Registers inline and statement printers to render IR closer to FunC stdlib API.

import { registerInlinePrinter, registerInlinePrinterPrefix, registerStmtPrinter } from "./printer";

// Helpers
const comma = (xs: string[]) => xs.join(", ");

// Statement helpers for common slice load patterns
function registerSliceLoadStmt(
  mnemonic: string,
  methodName: string,
  extraArgs?: (ctx: any) => string[],
  remainderOutName: string = 's2',
) {
  registerStmtPrinter(mnemonic, (_st, ctx) => {
    const anc = ctx.ensureSliceAnchor(ctx.inRaw('s'), ctx.outRaw(remainderOutName));
    if (!anc) return null;
    const lines: string[] = [];
    if (anc.preAssign) lines.push(anc.preAssign);
    const args = extraArgs ? extraArgs(ctx) : [];
    // Prefer the extracted value over the remainder (s3 before s2)
    const outId = ctx.outRaw('x')?.id || ctx.outRaw('c')?.id || ctx.outRaw('D')?.id || ctx.outRaw('s3')?.id || ctx.outRaw('s2')?.id;
    if (!outId) return null;
    lines.push(`${outId} = ${anc.anchorId}~${methodName}(${comma(args)})`);
    return lines;
  });
}

export function registerPrinters() {
  // Arithmetic (FunC built-ins style)
  registerInlinePrinter('ADD', (_st, ctx) => `${ctx.inP('x', 'left')} + ${ctx.inP('y', 'right')}`);
  registerInlinePrinter('SUB', (_st, ctx) => `${ctx.inP('x', 'left')} - ${ctx.inP('y', 'right')}`);
  registerInlinePrinter('MUL', (_st, ctx) => `${ctx.inP('x', 'left')} * ${ctx.inP('y', 'right')}`);
  registerInlinePrinter('DIV', (_st, ctx) => `${ctx.inP('x', 'left')} / ${ctx.inP('y', 'right')}`);
  registerInlinePrinter('MOD', (_st, ctx) => `${ctx.inP('x', 'left')} % ${ctx.inP('y', 'right')}`);
  registerInlinePrinter('NEGATE', (_st, ctx) => `-${ctx.inP('x', 'right')}`);

  // Bitwise operations
  registerInlinePrinter('AND', (_st, ctx) => `${ctx.inP('x', 'left')} & ${ctx.inP('y', 'right')}`);
  registerInlinePrinter('OR', (_st, ctx) => `${ctx.inP('x', 'left')} | ${ctx.inP('y', 'right')}`);
  registerInlinePrinter('XOR', (_st, ctx) => `${ctx.inP('x', 'left')} ^ ${ctx.inP('y', 'right')}`);
  registerInlinePrinter('NOT', (_st, ctx) => `~${ctx.inP('x', 'right')}`);

  // Shifts: immediate and variable
  registerInlinePrinter('LSHIFT', (_st, ctx) => `${ctx.inP('x', 'left')} << ${ctx.op('c')}`);
  registerInlinePrinter('RSHIFT', (_st, ctx) => `${ctx.inP('x', 'left')} >> ${ctx.op('c')}`);
  registerInlinePrinter('RSHIFTR', (_st, ctx) => `${ctx.inP('x', 'left')} ~>> ${ctx.op('c')}`);
  registerInlinePrinter('RSHIFTC', (_st, ctx) => `${ctx.inP('x', 'left')} ^>> ${ctx.op('c')}`);
  registerInlinePrinter('LSHIFT_VAR', (_st, ctx) => `${ctx.inP('x', 'left')} << ${ctx.inP('y', 'right')}`);
  registerInlinePrinter('RSHIFT_VAR', (_st, ctx) => `${ctx.inP('x', 'left')} >> ${ctx.inP('y', 'right')}`);
  registerInlinePrinter('RSHIFTR_VAR', (_st, ctx) => `${ctx.inP('x', 'left')} ~>> ${ctx.inP('y', 'right')}`);
  registerInlinePrinter('RSHIFTC_VAR', (_st, ctx) => `${ctx.inP('x', 'left')} ^>> ${ctx.inP('y', 'right')}`);

  // Div/mod combos
  registerInlinePrinter('DIVMOD', (_st, ctx) => `divmod(${ctx.in('x')}, ${ctx.in('y')})`);
  registerInlinePrinter('MULDIV', (_st, ctx) => `muldiv(${ctx.in('x')}, ${ctx.in('y')}, ${ctx.in('z')})`);
  registerInlinePrinter('MULDIVR', (_st, ctx) => `muldivr(${ctx.in('x')}, ${ctx.in('y')}, ${ctx.in('z')})`);
  registerInlinePrinter('MULDIVC', (_st, ctx) => `muldivc(${ctx.in('x')}, ${ctx.in('y')}, ${ctx.in('z')})`);
  registerInlinePrinter('MULDIVMOD', (_st, ctx) => `muldivmod(${ctx.in('x')}, ${ctx.in('y')}, ${ctx.in('z')})`);

  // Comparisons
  registerInlinePrinter('LESS', (_st, ctx) => `${ctx.inP('x', 'left')} < ${ctx.inP('y', 'right')}`);
  registerInlinePrinter('GREATER', (_st, ctx) => `${ctx.inP('x', 'left')} > ${ctx.inP('y', 'right')}`);
  registerInlinePrinter('LEQ', (_st, ctx) => `${ctx.inP('x', 'left')} <= ${ctx.inP('y', 'right')}`);
  registerInlinePrinter('GEQ', (_st, ctx) => `${ctx.inP('x', 'left')} >= ${ctx.inP('y', 'right')}`);
  registerInlinePrinter('NEQ', (_st, ctx) => `${ctx.inP('x', 'left')} != ${ctx.inP('y', 'right')}`);
  // Generic: collapse PUSHINT_* wrappers used as inline operands into bare literals
  registerInlinePrinterPrefix('PUSHINT_', (_st, ctx) => {
    const v = ctx.opRaw('x') ?? ctx.opRaw('i');
    if (v == null) return null;
    return ctx.formatInlineOperand(v);
  });

  registerInlinePrinterPrefix('PUSHCONT', (_st, ctx) => {
    return ctx.formatInlineOperand(ctx.opRaw('s')!);
  });

  // Cells/slices/builders construction and conversion
  registerInlinePrinter('NEWC', () => "begin_cell()");
  registerInlinePrinter('ENDC', (_st, ctx) => `${ctx.in('b')}.end_cell()`);
  registerInlinePrinter('CTOS', (_st, ctx) => `${ctx.in('c')}.begin_parse()`);
  registerInlinePrinter('ENDS', (_st, ctx) => `${ctx.in('s')}.end_parse()`);

  // Slice preloaders
  registerInlinePrinter('PLDU', (_st, ctx) => `${ctx.in('s')}.preload_uint(${ctx.op('c')})`);
  registerInlinePrinter('PLDI', (_st, ctx) => `${ctx.in('s')}.preload_int(${ctx.op('c')})`);
  registerInlinePrinter('PLDREF', (_st, ctx) => `${ctx.in('s')}.preload_ref()`);
  registerInlinePrinter('PLDDICT', (_st, ctx) => `${ctx.in('s')}.preload_dict()`);
  // Slice preloads for sub-slices
  registerInlinePrinter('PLDSLICE', (_st, ctx) => `${ctx.in('s')}.preload_bits(${ctx.op('c')})`);
  registerInlinePrinter('PLDSLICEX', (_st, ctx) => `${ctx.in('s')}.preload_bits(${ctx.in('l')})`);

  // Builder stores (method-style for readability)
  registerInlinePrinter('STU', (_st, ctx) => {
    return `${ctx.in('b')}.store_uint(${ctx.in('x')}, ${ctx.op('c')})`;
  });
  registerInlinePrinter('STI', (_st, ctx) => {
    return `${ctx.in('b')}.store_int(${ctx.in('x')}, ${ctx.op('c')})`;
  });
  registerInlinePrinter('STREF', (_st, ctx) => {
    return `${ctx.in('b')}.store_ref(${ctx.in('c')})`;
  });
  registerInlinePrinter('STSLICER', (_st, ctx) => {
    return `${ctx.in('b')}.store_slice(${ctx.in('s')})`;
  });
  registerInlinePrinter('STDICT', (_st, ctx) => {
    return `${ctx.in('b')}.store_dict(${ctx.in('D')})`;
  });
  registerInlinePrinter('STOPTREF', (_st, ctx) => {
    return `${ctx.in('b')}.store_maybe_ref(${ctx.in('c')})`;
  });
  registerInlinePrinter('STGRAMS', (_st, ctx) => {
    return `${ctx.in('b')}.store_grams(${ctx.in('x')})`;
  });
  registerInlinePrinter('STBR', (_st, ctx) => `${ctx.in('to') || ctx.in('b')}.store_builder(${ctx.in('from') || ctx.in('b2')})`);

  // Slice cuts/skips
  registerInlinePrinter('SDSKIPFIRST', (_st, ctx) => `${ctx.in('s')}.skip_bits(${ctx.in('l')})`);
  registerInlinePrinter('SDSKIPLAST', (_st, ctx) => `${ctx.in('s')}.skip_last_bits(${ctx.in('l')})`);
  registerInlinePrinter('SDCUTFIRST', (_st, ctx) => `${ctx.in('s')}.first_bits(${ctx.in('l')})`);
  registerInlinePrinter('SDCUTLAST', (_st, ctx) => `${ctx.in('s')}.slice_last(${ctx.in('l')})`);

  // Slice size/props
  registerInlinePrinter('SREFS', (_st, ctx) => `${ctx.in('s')}.slice_refs()`);
  registerInlinePrinter('SBITS', (_st, ctx) => `${ctx.in('s')}.slice_bits()`);
  registerInlinePrinter('SBITREFS', (_st, ctx) => `${ctx.in('s')}.slice_bits_refs()`);
  registerInlinePrinter('SEMPTY', (_st, ctx) => `${ctx.in('s')}.slice_empty?()`);
  registerInlinePrinter('SDEMPTY', (_st, ctx) => `${ctx.in('s')}.slice_data_empty?()`);
  registerInlinePrinter('SREMPTY', (_st, ctx) => `${ctx.in('s')}.slice_refs_empty?()`);
  registerInlinePrinter('SDEPTH', (_st, ctx) => `${ctx.in('s')}.slice_depth()`);

  // Builder size
  registerInlinePrinter('BREFS', (_st, ctx) => `${ctx.in('b')}.builder_refs()`);
  registerInlinePrinter('BBITS', (_st, ctx) => `${ctx.in('b')}.builder_bits()`);
  registerInlinePrinter('BDEPTH', (_st, ctx) => `${ctx.in('b')}.builder_depth()`);

  // Hashes
  registerInlinePrinter('HASHCU', (_st, ctx) => `${ctx.in('c')}.cell_hash()`);
  registerInlinePrinter('HASHSU', (_st, ctx) => `${ctx.in('s')}.slice_hash()`);
  registerInlinePrinter('SHA256U', (_st, ctx) => `${ctx.in('s')}.string_hash()`);

  // Comparisons and math
  registerInlinePrinter('EQUAL', (_st, ctx) => `${ctx.inP('x', 'left')} == ${ctx.inP('y', 'right')}`);
  registerInlinePrinter('INC', (_st, ctx) => `${ctx.inP('x', 'left')} + 1`);
  registerInlinePrinter('DEC', (_st, ctx) => `${ctx.inP('x', 'left')} - 1`);
  registerInlinePrinter('ABS', (_st, ctx) => `abs(${ctx.in('x')})`);
  registerInlinePrinter('MINMAX', (_st, ctx) => `minmax(${ctx.in('x')}, ${ctx.in('y')})`);

  // Debug and misc
  registerInlinePrinter('SDEQ', (_st, ctx) => `${ctx.in('a') || ctx.in('x') || ctx.in('s')}.equal_slice_bits(${ctx.in('b') || ctx.in('y')})`);

  // Storage (persistent data in c4)
  registerInlinePrinter('PUSHCTR', (_st, ctx) => {
    const i = ctx.opNum('i');
    if (i === 4) return `get_data()`;
    if (i === 3) return `get_c3()`;
    return undefined;
  });
  registerInlinePrinter('POPCTR', (_st, ctx) => {
    const i = ctx.opNum('i');
    if (i === 4) return `set_data(${ctx.in('x')})`;
    if (i === 3) return `set_c3(${ctx.in('x')})`;
    return undefined;
  });

  // Continuations
  registerInlinePrinter('BLESS', (_st, ctx) => `bless(${ctx.in('s')})`);

  // Accept / gas
  registerInlinePrinter('ACCEPT', () => `accept_message()`);
  registerInlinePrinter('SETGASLIMIT', (_st, ctx) => `set_gas_limit(${ctx.in('g')})`);

  // Params (aliases of GETPARAM)
  registerInlinePrinter('NOW', () => `now()`);
  registerInlinePrinter('MYADDR', () => `my_address()`);
  registerInlinePrinter('BALANCE', () => `get_balance()`);
  registerInlinePrinter('LTIME', () => `cur_lt()`);
  registerInlinePrinter('BLOCKLT', () => `block_lt()`);

  // GETPARAM generic mapping (covers NOW/BLOCKLT/LTIME/MYADDR/etc if decoded as GETPARAM)
  registerInlinePrinter('GETPARAM', (_st, ctx) => {
    switch (ctx.opNum('i')) {
      case 3: return 'now()';
      case 4: return 'block_lt()';
      case 5: return 'cur_lt()';
      case 7: return 'get_balance()';
      case 8: return 'my_address()';
      case 10: return 'my_code()';
      default: return undefined;
    }
  });

  // Random
  registerInlinePrinter('RANDU256', () => `random()`);
  registerInlinePrinter('RAND', (_st, ctx) => `rand(${ctx.in('x')})`);
  registerInlinePrinter('RANDSEED', () => `get_seed()`);
  registerInlinePrinter('SETRAND', (_st, ctx) => `set_seed(${ctx.in('x')})`);
  registerInlinePrinter('ADDRAND', (_st, ctx) => `randomize(${ctx.in('x')})`);

  // Signatures
  registerInlinePrinter('CHKSIGNU', (_st, ctx) => `check_signature(${ctx.in('h')}, ${ctx.in('s')}, ${ctx.in('k')})`);
  registerInlinePrinter('CHKSIGNS', (_st, ctx) => `check_data_signature(${ctx.in('d')}, ${ctx.in('s')}, ${ctx.in('k')})`);

  // Config and utils
  registerInlinePrinter('CONFIGOPTPARAM', (_st, ctx) => `config_param(${ctx.in('x')})`);
  registerInlinePrinter('ISNULL', (_st, ctx) => `${ctx.in('c')}.null?()`);
  registerInlinePrinter('PUSHNULL', () => `null()`);

  // Messaging and code ops
  registerInlinePrinter('SENDRAWMSG', (_st, ctx) => `send_raw_message(${ctx.in('c')}, ${ctx.in('x')})`);
  registerInlinePrinter('SETCODE', (_st, ctx) => `set_code(${ctx.in('c')})`);
  registerInlinePrinter('RAWRESERVE', (_st, ctx) => `raw_reserve(${ctx.in('x')}, ${ctx.in('y')})`);
  registerInlinePrinter('RAWRESERVEX', (_st, ctx) => `raw_reserve_extra(${ctx.in('x')}, ${ctx.in('D')}, ${ctx.in('y')})`);

  // Address parsing
  registerInlinePrinter('PARSEMSGADDR', (_st, ctx) => `${ctx.in('s')}.parse_addr()`);
  registerInlinePrinter('REWRITESTDADDR', (_st, ctx) => `${ctx.in('s')}.parse_std_addr()`);
  registerInlinePrinter('REWRITEVARADDR', (_st, ctx) => `${ctx.in('s')}.parse_var_addr()`);

  // Slice load stmts (mutating slice)
  registerSliceLoadStmt('LDU', 'load_uint', (ctx) => [ctx.op('c')]);
  registerSliceLoadStmt('LDI', 'load_int', (ctx) => [ctx.op('c')]);
  registerSliceLoadStmt('LDGRAMS', 'load_grams');
  registerSliceLoadStmt('LDDICT', 'load_dict');
  registerSliceLoadStmt('LDREF', 'load_ref');
  registerSliceLoadStmt('LDMSGADDR', 'load_msg_addr', undefined, 's3');
  registerSliceLoadStmt('LDSLICE', 'load_bits', (ctx) => [ctx.op('c')]);
  registerSliceLoadStmt('LDSLICE_ALT', 'load_bits', (ctx) => [ctx.op('c')]);
  registerSliceLoadStmt('LDSLICEX', 'load_bits', (ctx) => [ctx.in('l')]);

  // Tuple and list helpers
  registerInlinePrinter('TUPLE', (st: any, ctx) => {
    const n = ctx.opNum('n');
    const args = st.inputs.map((i: any) => ctx.formatInputArg(i.value));
    if (n === 0) return `empty_tuple()`;
    if (n === 1) return `single(${comma(args)})`;
    if (n === 2) return `pair(${comma(args)})`;
    if (n === 3) return `triple(${comma(args)})`;
    if (n === 4) return `tuple4(${comma(args)})`;
    return `tuple(${comma(args)})`;
  });
  registerInlinePrinter('UNTUPLE', (_st, ctx) => {
    const n = ctx.opNum('n');
    if (n === 1) return `unsingle(${ctx.in('t')})`;
    if (n === 2) return `unpair(${ctx.in('t')})`;
    if (n === 3) return `untriple(${ctx.in('t')})`;
    if (n === 4) return `untuple4(${ctx.in('t')})`;
    return `untuple(${ctx.in('t')}, ${ctx.op('n')})`;
  });
  registerInlinePrinter('INDEX', (_st, ctx) => {
    const k = ctx.opNum('k');
    if (k === 0) return `first(${ctx.in('t')})`;
    if (k === 1) return `second(${ctx.in('t')})`;
    if (k === 2) return `third(${ctx.in('t')})`;
    if (k === 3) return `fourth(${ctx.in('t')})`;
    return `index(${ctx.in('t')}, ${ctx.op('k')})`;
  });
  registerInlinePrinter('INDEXVAR', (_st, ctx) => `index(${ctx.in('t')}, ${ctx.in('k')})`);

  // Powers of two
  registerInlinePrinter('POW2', (_st, ctx) => `1 << ${ctx.inP('y', 'right')}`);

  // Exceptions (throw/throw_if/etc.)
  registerInlinePrinter('THROW', (_st, ctx) => `throw(${ctx.op('n')})`);
  registerInlinePrinter('THROW_SHORT', (_st, ctx) => `throw(${ctx.op('n')})`);
  registerInlinePrinter('THROWANY', (_st, ctx) => `throw(${ctx.in('n')})`);
  registerInlinePrinter('THROWIF', (_st, ctx) => `throw_if(${ctx.op('n')}, ${ctx.in('f')})`);
  registerInlinePrinter('THROWIF_SHORT', (_st, ctx) => `throw_if(${ctx.op('n')}, ${ctx.in('f')})`);
  registerInlinePrinter('THROWANYIF', (_st, ctx) => `throw_if(${ctx.in('n')}, ${ctx.in('f')})`);
  registerInlinePrinter('THROWIFNOT', (_st, ctx) => `throw_unless(${ctx.op('n')}, ${ctx.in('f')})`);
  registerInlinePrinter('THROWIFNOT_SHORT', (_st, ctx) => `throw_unless(${ctx.op('n')}, ${ctx.in('f')})`);
  registerInlinePrinter('THROWANYIFNOT', (_st, ctx) => `throw_unless(${ctx.in('n')}, ${ctx.in('f')})`);
  registerInlinePrinter('THROWARG', (_st, ctx) => `throw_arg(${ctx.in('x')}, ${ctx.op('n')})`);
  registerInlinePrinter('THROWARG_SHORT', (_st, ctx) => `throw_arg(${ctx.in('x')}, ${ctx.op('n')})`);
  registerInlinePrinter('THROWARGIF', (_st, ctx) => `throw_arg_if(${ctx.in('x')}, ${ctx.op('n')}, ${ctx.in('f')})`);
  registerInlinePrinter('THROWARGIFNOT', (_st, ctx) => `throw_arg_unless(${ctx.in('x')}, ${ctx.op('n')}, ${ctx.in('f')})`);
  registerInlinePrinter('THROWARGANY', (_st, ctx) => `throw_arg(${ctx.in('x')}, ${ctx.in('n')})`);
  registerInlinePrinter('THROWARGANYIF', (_st, ctx) => `throw_arg_if(${ctx.in('x')}, ${ctx.in('n')}, ${ctx.in('f')})`);
  registerInlinePrinter('THROWARGANYIFNOT', (_st, ctx) => `throw_arg_unless(${ctx.in('x')}, ${ctx.in('n')}, ${ctx.in('f')})`);

  // Compare (spaceship operator)
  registerInlinePrinter('CMP', (_st, ctx) => `${ctx.inP('x', 'left')} <=> ${ctx.inP('y', 'right')}`);

  // Constants
  registerInlinePrinter('NIL', () => `Nil`);
}
