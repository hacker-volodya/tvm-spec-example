import { compileFunc, SourcesMap } from '@ton-community/func-js';
import { Decompiler } from '../../src/decompiler';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OpcodeParser } from '../../src/disasm';
import { Slice } from 'ton3-core';
import { tryDecodeFunctionDictFromRoot } from '../../src/frontend/loader';

export type FuncTestInput = string | SourcesMap;

export type FuncTestOptions = {
  targets?: string[];
  optLevel?: number;
  debugInfo?: boolean;
};

/**
 * Compiles FunC sources to a code BOC (as Buffer).
 * - If `input` is a string, it is used as 'main.fc' and targeted by default.
 * - If `input` is a map, all keys are used as sources; default target is the first key.
 */
export async function compileFuncToBoc(input: FuncTestInput, opts: FuncTestOptions = {}): Promise<Buffer> {
  const sources: SourcesMap = typeof input === 'string' ? { 'main.fc': input } : input;
  const targetDefaults = typeof input === 'string'
    ? ['main.fc']
    : (sources['main.fc'] ? ['main.fc'] : (Object.keys(sources).length === 1 ? [Object.keys(sources)[0]] : []));
  const targets = opts.targets ?? targetDefaults;
  if (!targets || targets.length === 0) {
    throw new Error('Please specify `targets` in FuncTestOptions when providing multiple source files');
  }

  const res = await compileFunc({ sources, targets, optLevel: opts.optLevel, debugInfo: opts.debugInfo });
  if (res.status !== 'ok') {
    throw new Error(`FunC compile error: ${res.message}`);
  }
  return Buffer.from(res.codeBoc, 'base64');
}

/**
 * Decompiles a FunC program (provided as sources or single string) to pseudocode text.
 * Under the hood: FunC -> BOC -> Decompiler -> Printer.
 */
export async function decompileFunc(input: FuncTestInput, opts: FuncTestOptions = {}): Promise<string> {
  const boc = await compileFuncToBoc((typeof input == 'string') ? input + '\n\n() main() { }' : input, opts);
  // Write to a temp file and let Decompiler load it like a real BOC
  const tmp = path.join(os.tmpdir(), `func-${Date.now()}-${Math.random().toString(16).slice(2)}.boc`);
  fs.writeFileSync(tmp, boc);
  try {
    const decomp = new Decompiler();
    const program = decomp.decompileFile(tmp);
    return decomp.format(program); // + '\n\n' + disassemble(BOC.from(boc as Uint8Array).root[0].slice());
  } finally {
    try { fs.unlinkSync(tmp); } catch { }
  }
}

export function disassemble(slice: Slice): string {
  const indentString = (str: string, count: number, indent = " ") => str.replace(/^/gm, indent.repeat(count));
  let code = "";
  const map = tryDecodeFunctionDictFromRoot(slice);
  if (map != null) {
    for (let [k, v] of map.entries()) {
      code += `// function ${k}\n`;
      code += disassemble(v);
      code += '\n';
    }
  }
  while (slice.bits.length > 0) {
    const [spec, operands] = OpcodeParser.nextInstruction(slice);
    code += spec.mnemonic;
    for (const operandSpec of spec.bytecode.operands) {
      if (operandSpec.type == 'subslice' || operandSpec.type == 'ref') {
        if (operandSpec.display_hints.some(h => h.type == 'continuation')) {
          const innerCont = disassemble(operands[operandSpec.name]);
          code += ' ' + operandSpec.name + '=<{\n' + indentString(innerCont, 4).trimEnd() + '\n}>';
          continue;
        }
      }
      code += ` ${operandSpec.name}=${operands[operandSpec.name]}`;
    }
    code += '\n'
  }
  return code;
}