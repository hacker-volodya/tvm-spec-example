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
  

export type StackVariable = { name: string };

export class GuardUnresolvedError extends Error {
    public constructor() {
        super("Attempt to access stack below unresolved conditional guard");
        this.name = "GuardUnresolvedError";
    }
}

// Internal representation of a conditional alignment guard.
// Guard protects a boundary counted from the top of the stack.
// `depth` means how many items above the guard are currently available for pop.
type GuardState = {
    depth: number; // number of safe pops above the guard
    // Branches collected so far (per-arm stack entries appended by conditional outputs)
    branches: StackVariable[][]; // all arms must have the same length to finalize
};

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
    private _stack: StackVariable[];
    private _guard: GuardState | null = null;

    public constructor(initialStack: StackVariable[]) {
        this._stack = initialStack;
    }

    public copy(): Stack {
        const s = new Stack(Array.from(this._stack));
        // copy guard state
        if (this._guard) {
            s._guard = {
                depth: this._guard.depth,
                branches: this._guard.branches.map((b) => Array.from(b)),
            };
        }
        return s;
    }

    public copyEntries(): StackVariable[] {
        return Array.from(this._stack);
    }

    // Debug dump removed

    public pop(): StackVariable {
        if (this._guard) {
            if (this._guard.depth <= 0) {
                throw new GuardUnresolvedError();
            }
            // one safe pop above the guard
            this._guard.depth -= 1;
        }
        let result = this._stack.pop();
        if (result == undefined) {
            throw new StackUnderflowError(1);
        }
        return result;
    }

    public push(): StackVariable {
        let v = { name: `var${Stack._varCounter++}` };
        this._stack.push(v);
        if (this._guard) {
            // keep guard boundary relative to top-of-stack
            this._guard.depth += 1;
        }
        return v;
    }

    // Allocate a new variable name without pushing to stack
    public static allocVar(): StackVariable {
        return { name: `var${Stack._varCounter++}` };
    }

    public insertArgs(start: number, length: number): StackVariable[] {
        let result = [...new Array(length).keys()].map(i => ({ name: `arg${start + i}` }));
        this._stack.unshift(...result);
        return result;
    }

    // Guard management
    public hasGuard(): boolean { return this._guard !== null; }

    public ensureGuard(depthFromTop: number, armsCount: number) {
        if (!this._guard) {
            this._guard = { depth: depthFromTop, branches: new Array(armsCount).fill(0).map(() => []) };
        } else {
            // Keep the most restrictive boundary (closest to top)
            this._guard.depth = Math.min(this._guard.depth, depthFromTop);
            // Ensure arms count matches existing guard
            if (this._guard.branches.length !== armsCount) {
                // Resize by extending new arms with empty arrays or trimming extras
                if (this._guard.branches.length < armsCount) {
                    const add = armsCount - this._guard.branches.length;
                    for (let i = 0; i < add; i++) this._guard.branches.push([]);
                } else if (this._guard.branches.length > armsCount) {
                    this._guard.branches = this._guard.branches.slice(0, armsCount);
                }
            }
        }
    }

    public appendToGuardArm(armIndex: number, vars: StackVariable[]) {
        if (!this._guard) throw new Error("Guard is not initialized");
        if (armIndex < 0 || armIndex >= this._guard.branches.length) throw new Error("Guard arm index out of range");
        this._guard.branches[armIndex].push(...vars);
    }

    // Finalize guard if all arms have equalized lengths.
    // Returns merged variables inserted (possibly empty) on success, or null if not finalized.
    public tryFinalizeGuard(): StackVariable[] | null {
        if (!this._guard) return null;
        const lens = this._guard.branches.map(b => b.length);
        if (lens.length === 0) return null;
        const first = lens[0];
        if (!lens.every(l => l === first)) {
            // not aligned yet
            return null;
        }
        const count = first;
        if (count === 0) {
            // nothing to insert, just drop guard
            this._guard = null;
            return [];
        }
        // Insert merged variables just below the guard boundary
        const insertIndex = Math.max(0, this._stack.length - this._guard.depth);
        const merged: StackVariable[] = new Array(count).fill(0).map(() => ({ name: `var${Stack._varCounter++}` }));
        this._stack.splice(insertIndex, 0, ...merged);
        // Guard removed after equalization
        this._guard = null;
        return merged;
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
        if (this._guard) {
            throw new Error(`Stack operation '${insn.mnemonic}' is not allowed while conditional guard is active`);
        }
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
