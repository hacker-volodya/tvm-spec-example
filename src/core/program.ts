import type { IRFunction } from "../ir";

// Program representation for frontend output and backend input
// - A contract can be either a single entry function or a map of methods

export type SingleFunctionProgram = {
  kind: 'single';
  entry: IRFunction;
};

export type MultiFunctionProgram = {
  kind: 'multi';
  methods: Map<number, IRFunction>;
};

export type Program = SingleFunctionProgram | MultiFunctionProgram;

export function isMulti(p: Program): p is MultiFunctionProgram {
  return p.kind === 'multi';
}

export function isSingle(p: Program): p is SingleFunctionProgram {
  return p.kind === 'single';
}

