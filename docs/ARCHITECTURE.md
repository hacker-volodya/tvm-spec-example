# Decompiler Architecture

The codebase is organized following a typical compiler/decompiler pipeline:

- frontend
  - `loader.ts`: loads BOC and extracts root slice; detects function dictionary layout.
  - `lifter.ts`: lifts a `Slice` into IR; encapsulates disassembly and continuation decompilation logic.
- middle
  - `pipeline.ts`: pluggable pass pipeline with simple inlining passes (`opt/inline.ts`).
- backend
  - `printer.ts`: renders IR into human-readable text (reuses `formatIR`).
- core
  - `program.ts`: common Program model (single function or method map).

`src/decompiler.ts` wires these stages together and provides a single entry point:

```ts
const decomp = new Decompiler();
const program = decomp.decompileFile(path);
console.log(decomp.format(program));
```

This keeps lifting logic separate from IO and from optimization passes, so future work
like CFG, SSA, more analyses or backends can be added without touching other layers.
