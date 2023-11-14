import { BOC, Slice } from "ton3-core"
import * as fs from 'fs'
import { OpcodeParser } from "./disasm"

let disassembleSlice = (slice: Slice) => {
    let code = [];
    while (slice.bits.length > 0) {
        let [instruction, operands] = OpcodeParser.nextInstruction(slice);
        if (instruction.mnemonic == "PUSHCONT_SHORT") {
            operands["s"] = disassembleSlice(operands["s"]);
        }
        code.push({"opcode": instruction.mnemonic, "operands": operands});
    }
    return code;
};

const slice = BOC.from(new Uint8Array(fs.readFileSync(process.argv[2]))).root[0].slice();

console.dir(disassembleSlice(slice), { depth: null, color: true })