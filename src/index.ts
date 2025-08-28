import { BOC, Hashmap, Builder, Slice } from "ton3-core"
import * as fs from 'fs'
import { Continuation } from "./continuation";
import { formatIR } from "./ir";
import { inlinePrevSingleUse } from "./opt/inline";
import { OpcodeParser } from "./disasm";
import { bitsToIntUint } from "ton3-core/dist/utils/numbers";


const slice = BOC.from(new Uint8Array(fs.readFileSync(process.argv[2]))).root[0].slice();

function cloneSlice(s: Slice): Slice {
    return new Builder().storeBits(s.bits).storeRefs(s.refs).cell().slice();
}

function tryDecodeFunctionDictFromRoot(root: Slice): Map<number, ReturnType<Continuation['toIR']>> | null {
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

        // Parse dictionary as functions: key=int, value=Continuation
        const dict = Hashmap.parse<number, ReturnType<typeof Continuation.decompile>>(n, d, {
            deserializers: {
                key: (k: any) => bitsToIntUint(k, { type: 'int' }) as number,
                value: (v: any) => Continuation.decompile(v.slice())
            }
        });

        const result = new Map<number, ReturnType<Continuation['toIR']>>();
        dict.forEach((methodId: number, cont: ReturnType<typeof Continuation.decompile>) => {
            result.set(methodId, cont.toIR());
        });
        return result;
    } catch (_) {
        return null;
    }
}

const dictIR = tryDecodeFunctionDictFromRoot(slice);
if (dictIR) {
    // Print dictionary of functions, sorted by methodId
    const pairs = Array.from(dictIR.entries()).sort((a, b) => a[0] - b[0]);
    for (const [id, fn] of pairs) {
        console.log(`/* methodId: ${id} */`);
        console.log(formatIR(inlinePrevSingleUse(fn)));
        console.log();
    }
} else {
    const cont = Continuation.decompile(slice);
    console.log(formatIR(inlinePrevSingleUse(cont.toIR())))
}
