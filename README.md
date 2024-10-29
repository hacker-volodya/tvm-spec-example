# tvm-spec demo disassembler

PoC disassembler in just 150 lines of TypeScript using data from [tvm-spec](https://github.com/hacker-volodya/tvm-spec).

## Caveats

1. tvm-spec currently has no information about continuations in instruction operands, so it's tricky to decide whether we need to disassemble inner slices.

## Usage

```bash
git clone --recursive https://github.com/hacker-volodya/tvm-spec-example
cd tvm-spec-example
npm i
npm run build
node dist/index.js test_contracts/simple-wallet.boc
```

To regenerate tvm-spec interfaces from schema:

```bash
node gen-spec.js
```

Example output:

```
[
  { opcode: 'SETCP', operands: { n: 0 } },
  { opcode: 'PUSH', operands: { i: 0 } },
  { opcode: 'IFNOTRET', operands: {} },
  { opcode: 'PUSH', operands: { i: 0 } },
  { opcode: 'PUSHINT_LONG', operands: { x: 85143 } },
  { opcode: 'EQUAL', operands: {} },
  {
    opcode: 'PUSHCONT_SHORT',
    operands: {
      x: 7,
      s: [
        { opcode: 'POP', operands: { i: 0 } },
        { opcode: 'PUSHCTR', operands: { i: 4 } },
        { opcode: 'CTOS', operands: {} },
        { opcode: 'PLDU', operands: { c: 31 } }
      ]
    }
  },
  { opcode: 'IFJMP', operands: {} },
  { opcode: 'INC', operands: {} },
  { opcode: 'THROWIF_SHORT', operands: { n: 32 } },
  { opcode: 'PUSHINT_16', operands: { x: 512 } },
  { opcode: 'LDSLICEX', operands: {} },
  { opcode: 'PUSH', operands: { i: 0 } },
  { opcode: 'PLDU', operands: { c: 31 } },
  { opcode: 'PUSHCTR', operands: { i: 4 } },
  { opcode: 'CTOS', operands: {} },
  { opcode: 'LDU', operands: { c: 31 } },
  { opcode: 'LDU', operands: { c: 255 } },
  { opcode: 'ENDS', operands: {} },
  { opcode: 'XCPU', operands: { i: 1, j: 2 } },
  { opcode: 'EQUAL', operands: {} },
  { opcode: 'THROWIFNOT_SHORT', operands: { n: 33 } },
  { opcode: 'PUSH', operands: { i: 2 } },
  { opcode: 'HASHSU', operands: {} },
  { opcode: 'XC2PU', operands: { i: 0, j: 4, k: 4 } },
  { opcode: 'CHKSIGNU', operands: {} },
  { opcode: 'THROWIFNOT_SHORT', operands: { n: 34 } },
  { opcode: 'ACCEPT', operands: {} },
  { opcode: 'XCHG_0I', operands: { i: 1 } },
  { opcode: 'LDU', operands: { c: 31 } },
  { opcode: 'POP', operands: { i: 1 } },
  { opcode: 'LDU', operands: { c: 7 } },
  { opcode: 'LDREF', operands: {} },
  { opcode: 'ENDS', operands: {} },
  { opcode: 'XCHG_0I', operands: { i: 1 } },
  { opcode: 'SENDRAWMSG', operands: {} },
  { opcode: 'INC', operands: {} },
  { opcode: 'NEWC', operands: {} },
  { opcode: 'STU', operands: { c: 31 } },
  { opcode: 'STU', operands: { c: 255 } },
  { opcode: 'ENDC', operands: {} },
  { opcode: 'POPCTR', operands: { i: 4 } }
]
```
