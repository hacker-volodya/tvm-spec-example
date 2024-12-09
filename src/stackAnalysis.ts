import { VarMap } from "./disasm";
import { Instruction } from "./gen/tvm-spec";

export class StackUnderflowError extends Error {
    public underflowDepth: number;

    public constructor(underflowDepth: number) {
      super(`Stack underflow occured (depth = ${underflowDepth})`);
      this.name = "StackUnderflowError";
      this.underflowDepth = underflowDepth;
    }
  }
  

export type StackVariable = { name: string , type: string, metadata?: any};

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
    private static _varCounter = 0;
    private static _guardCounter = 0;
    private _stack: StackVariable[];

    public constructor(initialStack: StackVariable[]) {
        this._stack = initialStack;
    }

    public copy(): Stack {
        return new Stack(Array.from(this._stack));
    }

    public copyEntries(): StackVariable[] {
        return Array.from(this._stack);
    }

    public dump(): string {
        return this._stack
            .map(item => 
                item.type === "guard" 
                    ? `GUARD(${item.name})` // Customize guard display
                    : item.name // Display regular variable names
            )
            .join(", ");
    }
    
    public pop(): StackVariable {
        let result = this._stack.pop();
        if (result == undefined) {
            throw new StackUnderflowError(1);
        } else if (result.type === "guard") {
            throw new Error("Stack pop attempted on a guard. Use pop_guard instead.");
        }

        return result;
    }

    public push(): StackVariable {
        let v = { name: `var${Stack._varCounter++}`, type: "variable"};
        this._stack.push(v);
        return v;
    }

    public push_guard(metadata: any = {}): StackVariable {
        let guard = {
            name: `guard${Stack._guardCounter++}`,
            type: "guard",
            metadata,
        };
        this._stack.push(guard);
        return guard;
    }

    public pop_guard(): StackVariable {
        let result = this._stack.pop();
        if (!result) {
            throw new StackUnderflowError(1);
        }
        if (result.type !== "guard") {
            throw new Error("pop_guard called on non-guard item in the stack.");
        }
        return result;
    }

    public check_guard(): boolean {
        if (this._stack.length === 0) {
            return false;
        }
        let top = this._stack[this._stack.length - 1];
        return top.type === "guard";
    }

    public insertArgs(start: number, length: number): StackVariable[] {
        let result = [...new Array(length).keys()].map(i => ({ name: `arg${start + i}`, type: "argument" }));
        this._stack.unshift(...result);
        return result;
    }

    private xchg(i: number, j: number) {
        i = this._stack.length - 1 - i;
        j = this._stack.length - 1 - j;
        if (i < 0 || j < 0) {
            throw new StackUnderflowError(Math.max(-i, -j));
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
                        throw new StackUnderflowError(-index);
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
                    throw new StackUnderflowError(Math.max(-startIndex, -endIndex));
                }
                let reversedPart = this._stack.slice(startIndex, endIndex + 1).reverse();
                this._stack.splice(startIndex, length, ...reversedPart);
                break;
            }
        }
    }
}