import { Cell, Hashmap, Slice } from "ton3-core";
import { OpcodeParser, VarMap } from "./disasm";
import { Instruction } from "./gen/tvm-spec";
import { GuardUnresolvedError, Stack, StackUnderflowError, StackVariable } from "./stackAnalysis";
import { IRFunction, IROperands, IRInputs, IROpPrim, IROperandValue, IROutputs, IRValueDef, IRValueRef, formatIR } from "./ir";
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

    public toIR(): IRFunction {
        const isStackOp = (ins: DecompiledInstruction) => ["stack_basic", "stack_complex"].includes(ins.spec.doc.category);

        const convertOperands = (ops: VarMap): IROperands => {
            const res: IROperands = {};
            for (const [k, v] of Object.entries(ops)) {
                res[k] = this.convertOperandValue(v);
            }
            return res;
        };

        const args: IRValueDef[] = this.args.map((a) => ({ id: a.name }));
        const body: IROpPrim[] = [];

        for (const ins of this.code) {
            if (isStackOp(ins)) continue; // exclude raw stack ops from IR
            const inputs: IRInputs = {};
            for (const [name, val] of Object.entries(ins.inputs)) {
                const v = val as any as { var: StackVariable; types?: string[] };
                inputs[name] = { id: v.var.name, types: v.types as any } as IRValueRef;
            }
            const outputs: IROutputs = {};
            const outputsSpec = (ins.spec as any)?.value_flow?.outputs?.stack as any[] | undefined;
            const outMap = ins.outputs as any as { [k: string]: { var: StackVariable; types?: string[] } };
            if (outputsSpec && Array.isArray(outputsSpec)) {
                // write in spec order first (for stable pretty-printing)
                for (const o of outputsSpec) {
                    if (o.type === 'simple') {
                        const name = o.name as string;
                        const v = outMap[name];
                        if (v) outputs[name] = { id: v.var.name, types: v.types as any } as IRValueDef;
                    } else if (o.type === 'const') {
                        // keep any const* in insertion order afterwards
                    }
                }
                // append remaining outputs in their original insertion order
                for (const [name, v] of Object.entries(outMap)) {
                    if (!(name in outputs)) {
                        outputs[name] = { id: v.var.name, types: v.types as any } as IRValueDef;
                    }
                }
            } else {
                // fallback: preserve insertion order
                for (const [name, val] of Object.entries(ins.outputs)) {
                    const v = val as any as { var: StackVariable; types?: string[] };
                    outputs[name] = { id: v.var.name, types: v.types as any } as IRValueDef;
                }
            }

            const operands: IROperands = convertOperands({ ...ins.operands });
            body.push({ kind: 'prim', spec: ins.spec, mnemonic: ins.spec.mnemonic, inputs, operands, outputs });
        }

        const result: IRValueRef[] = this.resultStack.map((s) => ({ id: s.name }));

        const asmTail = this.asmTail?.map((i) => ({ spec: i.spec, operands: this.convertOperandsForTail(i.operands) })) ?? [];
        const tailSliceInfo = (this.sliceTail.bits.length > 0 || this.sliceTail.refs.length > 0) ? String(this.sliceTail) : undefined;

        return {
            kind: 'function',
            args,
            body,
            result,
            asmTail: asmTail.length ? asmTail : undefined,
            tailSliceInfo,
            decompileError: this.decompileError ? String(this.decompileError) : null,
            disassembleError: this.disassembleError ? String(this.disassembleError) : null,
        };
    }

    private convertOperandValue(v: any): IROperandValue {
        if (v instanceof Continuation) {
            return v.toIR();
        }
        if (v instanceof Hashmap) {
            const m = new Map<number, IRFunction>();
            (v as Hashmap<number, Continuation>).forEach((k: number, cont: Continuation) => {
                m.set(k, cont.toIR());
            });
            return m;
        }
        return v as IROperandValue;
    }

    private convertOperandsForTail(ops: VarMap): IROperands {
        const res: IROperands = {};
        for (const [k, v] of Object.entries(ops)) {
            res[k] = this.convertOperandValue(v);
        }
        return res;
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
        // Spec lists stack entries from deepest to top; pop from top
        for (let input of instruction.spec.value_flow.inputs.stack.slice().reverse()) {
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
        // To support conditional outputs we need to create a guard that blocks
        // access to the unaligned portion of the stack until it is equalized.
        // We iterate outputs in reverse order (as initially) but keep track of
        // how many values we have pushed in this instruction so far to place
        // the guard below them.
        let pushedThisInsn = 0;
        // Spec lists outputs from deepest to top; push in this order
        for (let output of instruction.spec.value_flow.outputs.stack) {
            if (output.type == 'simple') {
                const v = stack.push();
                pushedThisInsn += 1;
                stackOutputs[output.name] = { var: v, types: output.value_types };
            } else if (output.type == 'const') {
                const v = stack.push();
                pushedThisInsn += 1;
                stackOutputs[`const${constCounter++}`] = { var: v, types: [output.value_type] };
            } else if (output.type == 'conditional') {
                // Create / update guard at boundary below values pushed so far
                const arms = [...(output.match ?? []).map(x => x.stack ?? []), ...(output.else ? [output.else] : [])];
                const armsCount = arms.length;
                stack.ensureGuard(pushedThisInsn, armsCount);
                // For each arm, append branch-specific variables (without pushing them to stack now)
                arms.forEach((arm, idx) => {
                    const newVars: StackVariable[] = [];
                    for (const ent of arm) {
                        if (ent.type === 'simple') {
                            newVars.push(Stack.allocVar());
                        } else if (ent.type === 'const') {
                            newVars.push(Stack.allocVar());
                        } else {
                            throw new Error(`unsupported conditional branch entry '${ent.type}' in ${instruction.spec.mnemonic}`);
                        }
                    }
                    stack.appendToGuardArm(idx, newVars);
                });
                // Try to finalize if all arms produce the same additional stack layout
                stack.tryFinalizeGuard();
            } else {
                throw new Error(`not supported stack output '${(output as any).type}' while parsing ${instruction.spec.mnemonic}`);
            }
        }
        // Attempt to finalize guard if it got aligned by this instruction
        stack.tryFinalizeGuard();
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
                        // debug logs removed to keep output clean
                        let stack2 = stack.copy();
                        code.push(Continuation.decompileInstruction(decodedInsn, stack2));
                        stack = stack2;
                        break;
                    } catch (e) {
                        // Check for stack underflow
                        if (e instanceof StackUnderflowError && t < 10) {
                            let newArgs = stack.insertArgs(args.length, e.underflowDepth);
                            args.unshift(...newArgs);
                            continue;
                        }
                        // If we tried to pop while guard is unresolved - stop decompilation
                        if (e instanceof GuardUnresolvedError) {
                            decompileError = e;
                            break;
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
