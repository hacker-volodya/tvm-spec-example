import type { Instruction, PossibleValueTypes } from "../gen/tvm-spec";
import type { Slice, Cell } from "ton3-core";

// Intermediate Representation (IR) core types

export type IRType = PossibleValueTypes[number];

export type IRValueId = string;

export type IRValueRef = {
  id: IRValueId;
  types?: IRType[];
};

export type IRValueDef = {
  id: IRValueId;
  types?: IRType[];
};

export type IROperandValue = number | bigint | boolean | Slice | Cell | IRFunction | Map<number, IRFunction> | unknown;

export type IROperands = { [name: string]: IROperandValue };

export type IRInlineExpr = {
  kind: 'inline';
  op: IROpPrim;
};

export type IRInputArg = IRValueRef | IRInlineExpr;

export type IRInputs = { [name: string]: IRInputArg };

export type IROutputs = { [name: string]: IRValueDef };

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

