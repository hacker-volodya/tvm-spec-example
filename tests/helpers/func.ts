import { compileFunc, SourcesMap } from '@ton-community/func-js';
import { OpcodeParser } from '../../src/disasm';
import { BOC, Slice } from 'ton3-core';
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
export async function compileFuncToSlice(input: FuncTestInput, opts: FuncTestOptions = {}): Promise<Slice> {
  const sources: SourcesMap = typeof input === 'string' ? { 'main.fc': input + '\n\n() main() { }' } : input;
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
  return BOC.from(res.codeBoc).root[0].slice();
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