import { defaultPipeline } from '../src/middle/pipeline';
import { IRFunction, IROpPrim, IRValueDef, IRValueRef } from '../src/ir';
import type { Instruction } from '../src/gen/tvm-spec';

function fakeSpec(category: string): Instruction {
  // Provide only fields used by the code under test; cast to Instruction
  const spec: any = {
    mnemonic: 'FAKE',
    since_version: 9999,
    doc: {
      opcode: '',
      stack: '',
      category,
      description: '',
      gas: '',
      fift: '',
      fift_examples: [],
    },
    bytecode: { tlb: '', prefix: '00', operands: [] },
    value_flow: { inputs: { registers: [] }, outputs: { registers: [] } },
    control_flow: { branches: [], nobranch: true },
  };
  return spec as Instruction;
}

function op(
  mnemonic: string,
  outputs: Record<string, IRValueDef>,
  inputs: Record<string, IRValueRef | { kind: 'inline'; op: IROpPrim }> = {},
  category = 'misc'
): IROpPrim {
  return {
    kind: 'prim',
    spec: fakeSpec(category),
    mnemonic,
    inputs,
    operands: {},
    outputs,
  };
}

describe('defaultPipeline snapshot', () => {
  test('inlines single-use const producer into consumer', () => {
    const v1: IRValueDef = { id: 'v1' };
    const y1: IRValueDef = { id: 'y1' };

    const constOp = op('PUSHCONST', { v: v1 }, {}, 'const_int');
    const consumer = op('ADD', { y: y1 }, { a: { id: 'v1' }, b: { id: 'arg0' } });

    const fn: IRFunction = {
      kind: 'function',
      args: [{ id: 'arg0' }],
      body: [constOp, consumer],
      result: [{ id: 'y1' }],
    };

    const out = defaultPipeline().run(fn);
    expect(out).toMatchSnapshot();
  });

  test('inlines previous single-use non-const op', () => {
    const t: IRValueDef = { id: 't' };
    const y: IRValueDef = { id: 'y' };

    const prev = op('SHL', { t }, { a: { id: 'arg0' } }, 'misc');
    const curr = op('NEGATE', { y }, { x: { id: 't' } }, 'misc');

    const fn: IRFunction = {
      kind: 'function',
      args: [{ id: 'arg0' }],
      body: [prev, curr],
      result: [{ id: 'y' }],
    };

    const out = defaultPipeline().run(fn);
    expect(out).toMatchSnapshot();
  });

  test('does not inline producer if its value is part of result', () => {
    const v: IRValueDef = { id: 'vres' };
    const y: IRValueDef = { id: 'y' };

    const producer = op('PUSHCONST', { v }, {}, 'const_int');
    // Single use in consumer, but value is also listed in result
    const consumer = op('USE', { y }, { a: { id: 'vres' } }, 'misc');

    const fn: IRFunction = {
      kind: 'function',
      args: [],
      body: [producer, consumer],
      result: [{ id: 'vres' }, { id: 'y' }],
    };

    const out = defaultPipeline().run(fn);
    expect(out).toMatchSnapshot();
  });
});
