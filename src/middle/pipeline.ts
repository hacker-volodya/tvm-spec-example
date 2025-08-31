import type { IRFunction, IROperandValue } from "../core/ir";
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
      for (const op of st.operands) {
        const next = this.runOnOperand(op.value as IROperandValue);
        if (next !== op.value) op.value = next;
      }
    }
    // Apply passes to the current function
    return this.passes.reduce((acc, p) => p(acc), fn);
  }

  private runOnOperand(v: IROperandValue): IROperandValue {
    if (v.kind === 'cont') {
      const nextFn = this.run(v.value);
      return nextFn === v.value ? v : { kind: 'cont', value: nextFn };
    }
    if (v.kind === 'cont_map') {
      const out = new Map<number, IRFunction>();
      let changed = false;
      v.value.forEach((fn, k) => {
        const next = this.run(fn);
        out.set(k, next);
        if (next !== fn) changed = true;
      });
      return changed ? { kind: 'cont_map', value: out } : v;
    }
    return v;
  }
}

export function defaultPipeline(): Pipeline {
  return new Pipeline()
    .use(inlineConsts)
    .use(inlinePrevSingleUse);
}
