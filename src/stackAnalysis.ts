import { VarMap } from "./disasm";
import { Instruction } from "./gen/tvm-spec";

export type StackVariable = { name: string };

export type BasicStackOperation = 
    { op: 'xchg', i: number, j: number } |
    { op: 'blkpush', i: number, j: number } |
    { op: 'blkpop', i: number, j: number } |
    { op: 'reverse', i: number, j: number };

export type StackOperation = BasicStackOperation | 
    { op: 'push', i: number } |
    { op: 'pop', i: number } |
    { op: 'xcpu', i: number, j: number } |
    { op: 'xc2pu', i: number, j: number, k: number } |
    { op: 'xchg2', i: number, j: number };

export class Stack {
    private _varCounter: number;
    private _stack: StackVariable[];

    public constructor(initialStack: StackVariable[]) {
        this._stack = initialStack;
        this._varCounter = 0;
    }

    public copy(): Stack {
        return new Stack(Array.from(this._stack));
    }

    public dump(): string {
        return this._stack.map(se => se.name).join(', ');
    }

    public pop(): StackVariable {
        let result = this._stack.pop();
        if (result == undefined) {
            throw new Error("Stack underflow");
        }
        return result;
    }

    public push(): StackVariable {
        let v = { name: `var${this._varCounter++}` };
        this._stack.push(v);
        return v;
    }

    private xchg(i: number, j: number) {
        i = this._stack.length - 1 - i;
        j = this._stack.length - 1 - j;
        if (i < 0 || j < 0) {
            throw new Error("Stack underflow");
        }
        [this._stack[i], this._stack[j]] = [this._stack[j], this._stack[i]];
    }

    public execStackInstruction(insn: Instruction, operands: VarMap) {
        switch (insn.mnemonic) {
            case 'PUSH': {
                this.execStackOperation({ op: 'push', i: operands.i });
                break;
            }
            case 'POP': {
                this.execStackOperation({ op: 'pop', i: operands.i });
                break;
            }
            case 'XCPU': {
                this.execStackOperation({ op: 'xcpu', i: operands.i, j: operands.j });
                break;
            }
            case 'XC2PU': {
                this.execStackOperation({ op: 'xc2pu', i: operands.i, j: operands.j, k: operands.k });
                break;
            }
            case 'XCHG_0I': {
                this.execStackOperation({ op: 'xchg', i: 0, j: operands.i });
                break;
            }
        }
    }

    private execStackOperation(op: StackOperation) {
        switch (op.op) {
            case "xchg":
            case "blkpush":
            case "blkpop":
            case "reverse": {
                this.execBasicStackOperation(op);
                return;
            }
            case "push": {
                this.execStackOperation({ op: 'blkpush', i: 1, j: op.i });
                break;
            }
            case "pop": {
                this.execStackOperation({ op: 'blkpop', i: 1, j: op.i });
                break;
            }
            case "xcpu": {
                this.execStackOperation({ op: 'xchg', i: 0, j: op.i });
                this.execStackOperation({ op: 'push', i: op.j });
                break;
            }
            case "xc2pu": {
                this.execStackOperation({ op: 'xchg2', i: op.i, j: op.j });
                this.execStackOperation({ op: 'push', i: op.k });
                break;
            }
            case "xchg2": {
                this.execStackOperation({ op: 'xchg', i: 1, j: op.i });
                this.execStackOperation({ op: 'xchg', i: 0, j: op.j });
                break;
            }
        }
    }

    private execBasicStackOperation(op: BasicStackOperation) {
        switch (op.op) {
            case "xchg": {
                this.xchg(op.i, op.j);
                break;
            }
            case "blkpush": {
                for (let i = 0; i < op.i; i++) {
                    let index = this._stack.length - 1 - op.j;
                    if (index < 0) {
                        throw new Error("Stack underflow");
                    }
                    this._stack.push(this._stack[index]);
                }
                break;
            }
            case "blkpop": {
                for (let i = 0; i < op.i; i++) {
                    this.xchg(0, op.j);
                    this._stack.pop();
                }
                break;
            }
            case "reverse": {
                let length = op.i + 2;
                let endIndex = this._stack.length - 1 - op.j;
                let startIndex = endIndex + 1 - length;
                if (startIndex < 0 || endIndex < 0) {
                    throw new Error("Stack underflow");
                }
                let reversedPart = this._stack.slice(startIndex, endIndex + 1).reverse();
                this._stack.splice(startIndex, length, ...reversedPart);
                break;
            }
        }
    }
}