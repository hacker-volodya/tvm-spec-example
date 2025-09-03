import type { Instruction, PossibleValueTypes } from "../gen/tvm-spec";
import type { Slice, Cell } from "ton3-core";

// Intermediate Representation (IR) core types

export type IRType = PossibleValueTypes[number];

export type IRValueId = string;

export type IRValueRef = {
  id: IRValueId;
  types?: IRType[];
  continuationMeta?: {
      continuation: IRFunction;
  };
};

export type IRValueDef = {
  id: IRValueId;
  types?: IRType[];
};

// Algebraic data type for instruction operands
export type IROperandValue =
  | { kind: 'int'; value: number }
  | { kind: 'bigint'; value: bigint }
  | { kind: 'bool'; value: boolean }
  | { kind: 'slice'; value: Slice }
  | { kind: 'cell'; value: Cell }
  | { kind: 'cont'; value: IRFunction }
  | { kind: 'cont_map'; value: Map<number, IRFunction> }
  | { kind: 'other'; value: unknown };

export type IROperands = Array<{ name: string; value: IROperandValue }>;

export type IRInlineExpr = {
  kind: 'inline';
  op: IROpPrim;
};

export type IRInputArg = IRValueRef | IRInlineExpr;

export type IRInputs = Array<{ name: string; value: IRInputArg }>;

export type IROutputs = Array<{ name: string; value: IRValueDef }>;

export type IROpPrim = {
  kind: 'prim';
  spec: Instruction;
  mnemonic: string;
  inputs: IRInputs;
  operands: IROperands;
  outputs: IROutputs;
};

export type IRStmt = IROpPrim;

export type IRFunction = {
  kind: 'function';
  name?: string;
  args: IRValueDef[];
  body: IRStmt[];
  result: IRValueRef[];
  asmTail?: { spec: Instruction; operands: IROperands }[];
  tailSliceInfo?: string;
  decompileError?: string | null;
  disassembleError?: string | null;
};

export function isIRFunction(x: unknown): x is IRFunction {
  return !!x && typeof x === 'object' && (x as any).kind === 'function';
}
