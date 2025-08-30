import type { IRFunction } from "../ir";
import { inlinePrevSingleUse, inlineSingleUseConsts } from "../opt/inline";

export type Pass = (fn: IRFunction) => IRFunction;

export class Pipeline {
  private passes: Pass[] = [];

  use(pass: Pass): this {
    this.passes.push(pass);
    return this;
  }

  run(fn: IRFunction): IRFunction {
    return this.passes.reduce((acc, p) => p(acc), fn);
  }
}

export function defaultPipeline(): Pipeline {
  return new Pipeline()
    .use(inlineSingleUseConsts)
    .use(inlinePrevSingleUse);
}

