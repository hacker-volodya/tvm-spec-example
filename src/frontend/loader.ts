import { BOC, Hashmap, Builder, Slice } from "ton3-core";
import { OpcodeParser } from "../disasm";
import { bitsToIntUint } from "ton3-core/dist/utils/numbers";

// Low-level loader utilities (no lifting or IR here)

export function loadEntrySlice(path: string): Slice {
  const boc = BOC.from(new Uint8Array(require('fs').readFileSync(path)));
  return boc.root[0].slice();
}

export function cloneSlice(s: Slice): Slice {
  return new Builder().storeBits(s.bits).storeRefs(s.refs).cell().slice();
}

// Tries to decode entry point that dispatches dictionary of methods.
// Returns a map of methodId -> continuation slice if matched, otherwise null.
export function tryDecodeFunctionDictFromRoot(root: Slice): Map<number, Slice> | null {
  const sc = cloneSlice(root);
  try {
    // 1) SETCP
    const [ins1] = OpcodeParser.nextInstruction(sc);
    if (ins1.mnemonic !== 'SETCP') return null;
    // 2) DICTPUSHCONST
    const [ins2, ops2] = OpcodeParser.nextInstruction(sc);
    if (ins2.mnemonic !== 'DICTPUSHCONST') return null;
    const n: number = ops2['n'];
    const d: Slice = ops2['d'];
    // 3) DICTIGETJMPZ
    const [ins3] = OpcodeParser.nextInstruction(sc);
    if (ins3.mnemonic !== 'DICTIGETJMPZ') return null;
    // 4) THROWARG
    const [ins4] = OpcodeParser.nextInstruction(sc);
    if (ins4.mnemonic !== 'THROWARG') return null;
    // ensure no extra code in root
    if (sc.bits.length !== 0 || sc.refs.length !== 0) return null;

    // Parse dictionary as functions: key=int, value=Slice for continuation body
    const dict = Hashmap.parse<number, Slice>(n, d, {
      deserializers: {
        key: (k: any) => bitsToIntUint(k, { type: 'int' }) as number,
        value: (v: any) => v.slice() as Slice,
      },
    });

    const result = new Map<number, Slice>();
    dict.forEach((methodId: number, contSlice: Slice) => {
      result.set(methodId, contSlice);
    });
    return result;
  } catch (_) {
    return null;
  }
}

