# tvm-spec example decompiler

A small decompiler built on top of [tvm-spec](https://github.com/hacker-volodya/tvm-spec) with a clear pipeline split into frontend/middle/backend. See docs/ARCHITECTURE.md for the high-level overview.

## Usage

```bash
git clone --recursive https://github.com/hacker-volodya/tvm-spec-example
cd tvm-spec-example
npm i
npm run build
node dist/index.js test_contracts/simple-wallet.boc
```

The CLI loads a BOC, lifts it to an internal IR, runs simple inlining passes, and prints the result in a readable pseudo-code form.

To regenerate tvm-spec TypeScript types from the schema:

```bash
node gen-spec.js
```
