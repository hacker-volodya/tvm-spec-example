import { Cell, Hashmap, Slice } from "ton3-core";
import { OpcodeParser, VarMap } from "./disasm";
import { Instruction } from "./gen/tvm-spec";
import { Stack, StackUnderflowError, StackVariable } from "./stackAnalysis";
import { bitsToIntUint } from "ton3-core/dist/utils/numbers";

const CONTINUATIONS: { [key: string]: string[] } = {
    CALLREF: ["c"],
    JMPREF: ["c"],
    JMPREFDATA: ["c"],
    IFREF: ["c"],
    IFNOTREF: ["c"],
    IFJMPREF: ["c"],
    IFNOTJMPREF: ["c"],
    IFREFELSE: ["c"],
    IFELSEREF: ["c"],
    IFREFELSEREF: ["c1", "c2"],
    IFBITJMPREF: ["c"],
    IFNBITJMPREF: ["c"],
    PUSHCONT: ["s"],
    PUSHCONT_SHORT: ["s"],
}

export class Continuation {
    private args: StackVariable[];
    private code: DecompiledInstruction[];
    private resultStack: StackVariable[];
    private decompileError: any = null;
    private disassembleError: any = null;
    private asmTail: DecodedInstruction[];
    private sliceTail: Slice;

    private constructor(code: DecompiledInstruction[], args: StackVariable[], resultStack: StackVariable[], sliceTail: Slice, asmTail: DecodedInstruction[] = [], decompileError: any = null, disassembleError: any = null) {
        this.args = args;
        this.code = code;
        this.resultStack = resultStack;
        this.asmTail = asmTail;
        this.decompileError = decompileError;
        this.sliceTail = sliceTail;
        this.disassembleError = disassembleError;
    }

    private static dumpOperandConts(operands: VarMap): string[] { 
        let conts = [];
        for (const operand in operands) {
            let v = operands[operand];
            if (v instanceof Continuation) {
                conts.push(v.dump());
                delete operands[operand];
            }
            if (v instanceof Hashmap) {
                v.forEach((methodId: number, cont: Continuation) => {
                    conts.push(`/* methodId: ${methodId} */ ${cont.dump()}`);
                });
                delete operands[operand];
            }
        }
        return conts;
    }

    public dump(): string {
        const indentString = (str: string, count: number, indent = " ") => {
            indent = indent.repeat(count);
            return str.replace(/^/gm, indent);
        };
        const isStackOp = (ins: DecompiledInstruction) => ["stack_basic", "stack_complex"].includes(ins.spec.doc.category);

        // count variable usages
        let useCount: { [name: string]: number } = {};
        for (let instruction of this.code) {
            for (let input of Object.values(instruction.inputs)) {
                let name = (input as any).var.name;
                useCount[name] = (useCount[name] ?? 0) + 1;
            }
        }

        // determine instructions to inline
        let inlineMap: { [name: string]: string } = {};
        let skip = new Set<number>();

        const formatInstruction = (ins: DecompiledInstruction): string => {
            let operandsCopy = { ...ins.operands };
            let conts = Continuation.dumpOperandConts(operandsCopy);
            let operands = Object.values(operandsCopy).map(x => `${x}`);
            let inputVars = Object.values(ins.inputs).map((input: any) => inlineMap[input.var.name] ?? input.var.name);
            let inputStr = operands.concat(...inputVars).concat(...conts).join(', ');
            return `${ins.spec.mnemonic}(${inputStr})`;
        };

        for (let i = 0; i < this.code.length; i++) {
            let instruction = this.code[i];
            if (isStackOp(instruction)) continue;
            let outputs = Object.values(instruction.outputs).map((o: any) => o.var.name);
            if (outputs.length !== 1) continue;
            let outVar = outputs[0];
            if (useCount[outVar] !== 1) continue;
            let j = -1;
            for (let k = i + 1; k < this.code.length; k++) {
                let inputs = Object.values(this.code[k].inputs);
                if (inputs.some((inp: any) => inp.var.name === outVar)) {
                    j = k;
                    break;
                }
            }
            if (j === i + 1 && !isStackOp(this.code[j])) {
                inlineMap[outVar] = formatInstruction(instruction);
                skip.add(i);
            }
        }

        let code = "";
        for (let [index, instruction] of this.code.entries()) {
            if (skip.has(index)) continue;
            // hide stack operations
            if (isStackOp(instruction)) {
                //code += `// ${instruction.spec.mnemonic} ${Object.values(instruction.operands).map(x => `${x}`)}\n`;
                continue;
            }
            let outputVars = Object.values(instruction.outputs).map((output: any) => output.var.name).join(', ');
            let inputVars = Object.values(instruction.inputs).map((input: any) => inlineMap[input.var.name] ?? input.var.name);

            let operandsCopy = { ...instruction.operands };
            let conts = Continuation.dumpOperandConts(operandsCopy);
            let operands = Object.values(operandsCopy).map(x => `${x}`);
            let inputStr = operands.concat(...inputVars).concat(...conts).join(', ');
            code += (outputVars ? `${outputVars} = ` : '') + `${instruction.spec.mnemonic}(${inputStr});\n`;
        }
        code += "// result stack: " + this.resultStack.map(s => s.name).join(', ') + "\n";
        if (this.decompileError) {
            code += "// decompilation error: " + this.decompileError + "\n";
        }
        for (let instruction of this.asmTail) {
            let conts = Continuation.dumpOperandConts(instruction.operands);
            let operands = Object.values(instruction.operands).map(x => `${x}`);
            code += `${instruction.spec.mnemonic} ${operands.concat(...conts).join(', ')}\n`;
        }
        if (this.disassembleError) {
            code += `// Disassemble error: ${this.disassembleError}\n`;
        }
        if (this.sliceTail.bits.length > 0 || this.sliceTail.refs.length > 0) {
            code += `// Tail slice:\n${this.sliceTail}\n`;
        }
        return `function (${this.args.map(a => a.name).join(', ')}) {\n${indentString(code.trimEnd(), 4)}\n}`;
    }

    private static loadOpcode(slice: Slice): DecodedInstruction {
        let [instruction, operands] = OpcodeParser.nextInstruction(slice);
        return {
            spec: instruction,
            operands
        };
    }

    private static decompileInstruction(instruction: DecodedInstruction, stack: Stack): DecompiledInstruction {
        // Handle stack instructions
        if (["stack_basic", "stack_complex"].includes(instruction.spec.doc.category)) {
            stack.execStackInstruction(instruction.spec, instruction.operands);
            return {
                spec: instruction.spec,
                operands: instruction.operands,
                inputs: {},
                outputs: {},
                resultStack: stack.copyEntries()
            };
        }
        // Stop decompilation in case of unknown value flow
        if (instruction.spec.value_flow == undefined || instruction.spec.value_flow.inputs == undefined || instruction.spec.value_flow.outputs == undefined) {
            throw new Error(`instruction is missing value flow: ${instruction.spec.mnemonic}`);
        }
        // Pop inputs
        let stackInputs: VarMap = {};
        if (instruction.spec.value_flow.inputs.stack == undefined) {
            throw new Error(`Unconstrained stack input while parsing ${instruction.spec.mnemonic}`);
        }
        for (let input of instruction.spec.value_flow.inputs.stack.reverse()) {
            if (input.type == 'simple') {
                stackInputs[input.name] = { var: stack.pop(), types: input.value_types };
            } else {
                throw new Error(`not supported stack input '${input.type}' while parsing ${instruction.spec.mnemonic}`);
            }
        }
        // Pop outputs
        let stackOutputs: VarMap = {};
        let constCounter = 0;
        if (instruction.spec.value_flow.outputs.stack == undefined) {
            throw new Error(`Unconstrained stack output while parsing ${instruction.spec.mnemonic}`);
        }
        for (let output of instruction.spec.value_flow.outputs.stack.reverse()) {
            if (output.type == 'simple') {
                stackOutputs[output.name] = { var: stack.push(), types: output.value_types };
            } else if (output.type == 'const') {
                stackOutputs[`const${constCounter++}`] = { var: stack.push(), types: [output.value_type] };
            } else {
                throw new Error(`not supported stack output '${output.type}' while parsing ${instruction.spec.mnemonic}`);
            }
        }
        return {
            spec: instruction.spec,
            operands: instruction.operands,
            inputs: stackInputs,
            outputs: stackOutputs,
            resultStack: stack.copyEntries()
        };
    }

    public static decompile(slice: Slice, initialStack: StackVariable[] = []): Continuation {
        let code: DecompiledInstruction[] = [];
        let stack = new Stack(initialStack);
        let args: StackVariable[] = [];
        let decompileError: any = null;
        let asmTail: DecodedInstruction[] = [];
        while (slice.bits.length > 0) {
            let decodedInsn;
            try {
                decodedInsn = Continuation.loadOpcode(slice);
                if (decodedInsn.spec.mnemonic == "DICTPUSHCONST" && decodedInsn.operands["n"] == 19) {
                    decodedInsn.operands["d"] = Hashmap.parse<Number, Continuation>(19, decodedInsn.operands["d"], {
                        deserializers: {
                            key: k => bitsToIntUint(k, { type: "int" }),
                            value: v => Continuation.decompile(v.slice())
                        }
                    });
                }
                if (CONTINUATIONS[decodedInsn.spec.mnemonic] != undefined) {
                    for (let operand of CONTINUATIONS[decodedInsn.spec.mnemonic]) {
                        decodedInsn.operands[operand] = Continuation.decompile(decodedInsn.operands[operand]);
                    }
                }
            } catch (e) {
                return new Continuation(code, args, stack.copyEntries(), slice, asmTail, decompileError, e);
            }
            if (decompileError == null) {
                for (let t = 0;; t++) {
                    try {
                        console.log("in", stack.dump());
                        console.log(decodedInsn.spec.mnemonic);
                        let stack2 = stack.copy();
                        code.push(Continuation.decompileInstruction(decodedInsn, stack2));
                        stack = stack2;
                        console.log("out", stack.dump());
                        break;
                    } catch (e) {
                        // Check for stack underflow
                        if (e instanceof StackUnderflowError && t < 10) {
                            let newArgs = stack.insertArgs(args.length, e.underflowDepth);
                            args.unshift(...newArgs);
                            continue;
                        }
                        // Stop decompiling, try disassemble tail
                        decompileError = e;
                        break;
                    }
                }
            }
            if (decompileError != null) {
                asmTail.push(decodedInsn);
            }
            // indirect ref jump
            while (slice.bits.length == 0 && slice.refs.length > 0) {
                slice = slice.loadRef().slice();
            }
        }
        return new Continuation(code, args, stack.copyEntries(), slice, asmTail, decompileError);
    }
}

export interface DecodedInstruction {
    spec: Instruction;
    operands: VarMap;
}

export interface DecompiledInstruction {
    spec: Instruction;
    operands: VarMap;
    inputs: VarMap;
    outputs: VarMap;
    resultStack: StackVariable[];
}