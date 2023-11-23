import { BOC, Slice } from "ton3-core"
import * as fs from 'fs'
import { OpcodeParser, VarMap } from "./disasm"
import { Stack } from "./stackAnalysis";

let disassembleSlice = (slice: Slice) => {
    let code = [];
    while (slice.bits.length > 0) {
        let [instruction, operands] = OpcodeParser.nextInstruction(slice);
        if (instruction.mnemonic == "PUSHCONT_SHORT") {
            operands["s"] = disassembleSlice(operands["s"]);
        }
        code.push({ "instruction": instruction, "operands": operands, "inputs": instruction.value_flow?.inputs?.stack, "outputs": instruction.value_flow?.outputs?.stack });
    }
    return code;
};

const slice = BOC.from(new Uint8Array(fs.readFileSync(process.argv[2]))).root[0].slice();

let instructions = disassembleSlice(slice);

let stack = new Stack([{ name: "body" }, { name: "selector" }]);

let analyzeContStack = (instructions: any, stack: Stack) => {
    let valueFlow = [];
    for (let instruction of instructions) {
        if (instruction.inputs == undefined || instruction.outputs == undefined) {
            stack.execStackInstruction(instruction.instruction, instruction.operands);
            valueFlow.push({
                opcode: instruction.instruction.mnemonic,
                operands: instruction.operands
            });
            continue;
        }
        let newInputs: VarMap = {};
        for (let input of instruction.inputs.reverse()) {
            if (input.type == 'simple') {
                newInputs[input.name] = { var: stack.pop(), types: input.value_types };
            } else {
                throw new Error("not supported");
            }
        }
        let newOutputs: VarMap = {};
        for (let output of instruction.outputs) {
            if (output.type == 'simple') {
                newOutputs[output.name] = { var: stack.push(), types: output.value_types };
            } else {
                throw new Error("not supported");
            }
        }
        let newOperands: VarMap = {};
        for (const operand in instruction.operands) {
            let v = instruction.operands[operand];
            if (v instanceof Array) {
                v = analyzeContStack(v, stack.copy());
            }
            newOperands[operand] = v;
        }
        valueFlow.push({
            opcode: instruction.instruction.mnemonic,
            operands: newOperands,
            inputs: newInputs,
            outputs: newOutputs,
            stack: stack.copy()
        });
    }
    return valueFlow;
};

let vizualize = (valueFlow: any) => {
    const indentString = (str: string, count: number, indent = " ") => {
        indent = indent.repeat(count);
        return str.replace(/^/gm, indent);
      };
    let code = "";
    for (let instruction of valueFlow) {
        if (instruction.inputs == undefined || instruction.outputs == undefined) {
            continue;
        }
        let outputVars = Object.values(instruction.outputs).map((output: any) => output.var.name).join(', ');
        let inputVars = Object.values(instruction.inputs).map((input: any) => input.var.name);
        let conts = [];
        for (const operand in instruction.operands) {
            let v = instruction.operands[operand];
            if (v instanceof Array) {
                conts.push("{\n" + indentString(vizualize(v), 4) + "\n}");
                delete instruction.operands[operand];
            }
        }
        let operands = Object.values(instruction.operands).map(x => `${x}`);
        let inputStr = conts.concat(...operands).concat(...inputVars).join(', ');
        code += (outputVars ? `${outputVars} = ` : '') + `${instruction.opcode}(${inputStr});\n`;
    }
    code += "// result stack: " + valueFlow[valueFlow.length - 1].stack.dump();
    return code;
};

let valueFlow = analyzeContStack(instructions, stack);

let code = vizualize(valueFlow);

console.dir(valueFlow, { depth: null, color: true })

console.log(code)