import type { Program } from "./core/program";
import { defaultPipeline } from "./middle/pipeline";
import { printProgram } from "./backend/printer";
import { liftSliceToIR } from "./frontend/lifter";
import { loadEntrySlice, tryDecodeFunctionDictFromRoot } from "./frontend/loader";
import { Slice } from "ton3-core";

export class Decompiler {
  decompileSlice(root: Slice): Program {
    const dict = tryDecodeFunctionDictFromRoot(root);
    if (dict) {
      const methods = new Map<number, ReturnType<typeof liftSliceToIR>>();
      dict.forEach((contSlice, id) => {
        const ir = liftSliceToIR(contSlice);
        methods.set(id, this.runMiddle(ir));
      });
      return { kind: 'multi', methods };
    } else {
      const ir = liftSliceToIR(root);
      return { kind: 'single', entry: this.runMiddle(ir) };
    }
  }

  decompileFile(path: string): Program {
    const root = loadEntrySlice(path);
    return this.decompileSlice(root);
  }

  private runMiddle(fn: ReturnType<typeof liftSliceToIR>) {
    const pipeline = defaultPipeline();
    return pipeline.run(fn);
  }

  format(p: Program): string {
    return printProgram(p);
  }
}
