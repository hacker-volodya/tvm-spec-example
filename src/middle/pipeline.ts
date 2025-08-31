import type { IRFunction, IROperandValue } from "../core/ir";
import { isIRFunction } from "../core/ir";
import { inlinePrevSingleUse, inlineConsts } from "../opt/inline";

export type Pass = (fn: IRFunction) => IRFunction;

export class Pipeline {
  private passes: Pass[] = [];

  use(pass: Pass): this {
    this.passes.push(pass);
    return this;
  }

  run(fn: IRFunction): IRFunction {
    // Recursively process continuations (IRFunctions embedded in operands)
    for (const st of fn.body) {
      for (const [k, v] of Object.entries(st.operands)) {
        const next = this.runOnOperand(v as IROperandValue);
        if (next !== v) st.operands[k] = next;
      }
    }
    // Apply passes to the current function
    return this.passes.reduce((acc, p) => p(acc), fn);
  }

  private runOnOperand(v: IROperandValue): IROperandValue {
    if (isIRFunction(v)) {
      return this.run(v);
    }
    if (v instanceof Map) {
      const out = new Map<number, IRFunction>();
      let changed = false;
      (v as Map<number, IRFunction>).forEach((fn, k) => {
        const next = this.run(fn);
        out.set(k, next);
        if (next !== fn) changed = true;
      });
      return changed ? out : v;
    }
    return v;
  }
}

export function defaultPipeline(): Pipeline {
  return new Pipeline()
    .use(inlineConsts)
    .use(inlinePrevSingleUse);
}
