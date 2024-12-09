import { cp0 } from "./tvm-spec";
import { Instruction, Operand } from "./gen/tvm-spec";
import { Bit, Builder, Slice } from "ton3-core";

export type VarMap = { [key: string]: any };
type Loader = (s: Slice, operands: VarMap, loader_args: VarMap) => any;

let intToBin = (n: number, size: number) => [...Array(size)].map((x, i) => (n >> i & 1) as Bit).reverse();

let bitsToStr = (bits: Bit[]) => bits.map(x => x.toString()).join('');

let prefixToBin = (prefix: string) => {
    let completionTag = prefix.endsWith('_');
    if (completionTag) {
        prefix.slice(0, -1);
    }
    let bits = prefix.split("").flatMap(hex => intToBin(parseInt(hex, 16), 4));
    if (completionTag) {
        bits = removeCompletionTag(bits);
    }
    return bitsToStr(bits);
};

let removeCompletionTag = (bits: Bit[]) => {
    let newLength = bits.lastIndexOf(1);
    if (newLength == -1) {
        throw new Error("no completion tag");
    }
    return bits.slice(0, newLength);
};

let getLoaders: () => { [key: string]: Loader } = () => ({
    int: (s, ops, args) => s.loadInt(args.size),
    uint: (s, ops, args) => s.loadUint(args.size),
    ref: (s, ops, args) => s.loadRef().slice(),
    pushint_long: (s, ops, args) => s.loadInt(8 * s.loadUint(5) + 19),
    subslice: (s, ops, args) => {
        let bitLength = (args.bits_padding ?? 0) + (args.bits_length_var ? 8 * ops[args.bits_length_var] : 0);
        let refLength = (args.refs_add ?? 0) + (args.refs_length_var ? ops[args.refs_length_var] : 0);
        let bits = s.loadBits(bitLength);
        if (args.completion_tag) {
            bits = removeCompletionTag(bits);
        }
        let refs = s.refs.slice(0, refLength);
        s.skipRefs(refLength);
        return new Builder().storeBits(bits).storeRefs(refs).cell().slice();
    },
});

export class OpcodeParser {
    private static _map: Map<string, Instruction>

    private static loadOperand(operand: Operand, slice: Slice) {
        if (operand.type == "uint") {
            return slice.loadUint(operand.size);
        } else if (operand.type == "int") {
            return slice.loadInt(operand.size);
        } else if (operand.type == "ref") {
            return slice.loadRef().slice();
        } else if (operand.type == "pushint_long") {
            return slice.loadInt(8 * slice.loadUint(5) + 19);
        } else if (operand.type == "subslice") {
            let refLength = (operand.refs_add ?? 0) + (operand.refs_length_var_size ? slice.loadUint(operand.refs_length_var_size) : 0);
            let bitLength = (operand.bits_padding ?? 0) + (operand.bits_length_var_size ? slice.loadUint(operand.bits_length_var_size)*8 : 0);
            let bits = slice.loadBits(bitLength);
            if (operand.completion_tag) {
                bits = removeCompletionTag(bits);
            }
            let refs = slice.refs.slice(0, refLength);
            slice.skipRefs(refLength);
            return new Builder().storeBits(bits).storeRefs(refs).cell().slice();
        } else {
            throw new Error('unimplemented');
        }
    }

    private static getMap() {
        return this._map || (this._map = new Map(cp0.instructions.map(insn => [prefixToBin(insn.bytecode.prefix), insn])))
    }

    private static getLongestPrefixLength() {
        return Math.max(...cp0.instructions.map(insn => prefixToBin(insn.bytecode.prefix).length));
    }

    private static loadPrefix(slice: Slice): Instruction {
        for (let bits = 1; bits <= this.getLongestPrefixLength(); bits++) {
            let prefix = bitsToStr(slice.preloadBits(bits));
            let instruction = this.getMap().get(prefix);
            if (instruction == undefined) continue;
            let rangeCheck = instruction.bytecode.operands_range_check;
            if (rangeCheck != undefined) {
                let operands = new Builder().storeBits(slice.bits).storeRefs(slice.refs).cell().slice().skipBits(prefix.length).loadUint(rangeCheck.length);
                if (operands < rangeCheck.from || operands > rangeCheck.to) {
                    continue;
                }
            }
            slice.skipBits(bits);
            return instruction
        }
        throw new Error("Prefix not found");
    }

    public static nextInstruction(slice: Slice): [Instruction, VarMap] {
        let instruction;
        try {
            instruction = this.loadPrefix(slice);
        } catch (e) {
            throw new Error("OpcodeParser: prefix load error", { cause: e })
        }
        let operands: VarMap = {}
        for (let operand of instruction.bytecode.operands ?? []) {
            try {
                operands[operand.name] = this.loadOperand(operand, slice)
            } catch (e) {
                throw new Error(`OpcodeParser: bad operand ${operand.name} for instruction ${instruction.mnemonic} (${e})`, { cause: e })
            }
        }
        return [instruction, operands]
    }
}