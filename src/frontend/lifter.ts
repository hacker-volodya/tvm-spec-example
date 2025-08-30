import type { Slice } from "ton3-core";
import { Continuation } from "./continuation";
import type { IRFunction } from "../ir";

// Lifts a raw code slice to IRFunction via Continuation decompiler
export function liftSliceToIR(slice: Slice): IRFunction {
  const cont = Continuation.decompile(slice);
  return cont.toIR();
}
