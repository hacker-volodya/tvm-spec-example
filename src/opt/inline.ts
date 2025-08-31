import { IRFunction, IRInlineExpr, IRInputArg, IROpPrim, IRStmt, IRValueRef } from "../core/ir";

function isConstCategory(cat: string | undefined): boolean {
  return cat === 'const_int' || cat === 'const_data';
}

type UseSite = { stmtIndex: number; inputName: string };

export function inlineConsts(fn: IRFunction): IRFunction {
  const body = fn.body.slice();

  // Build producer map for single-output const instructions
  const producedBy: Map<string, { stmtIndex: number; stmt: IROpPrim }> = new Map();
  for (let i = 0; i < body.length; i++) {
    const st = body[i];
    const outs = st.outputs.map(o => o.value);
    if (outs.length !== 1) continue;
    const cat = st.spec?.doc?.category as string | undefined;
    if (!isConstCategory(cat)) continue;
    const id = outs[0].id;
    producedBy.set(id, { stmtIndex: i, stmt: st });
  }

  // Count uses and record use sites
  const useCount: Map<string, number> = new Map();
  const uses: Map<string, UseSite[]> = new Map();
  for (let i = 0; i < body.length; i++) {
    const st = body[i];
    for (const { name, value: arg } of st.inputs) {
      const ref = arg as IRInputArg;
      if ((ref as any).kind === 'inline') continue;
      const id = (ref as IRValueRef).id;
      useCount.set(id, (useCount.get(id) ?? 0) + 1);
      if (!uses.has(id)) uses.set(id, []);
      uses.get(id)!.push({ stmtIndex: i, inputName: name });
    }
  }

  // Collect ids also appearing in result stack to avoid removing their producers
  const resultIds = new Set(fn.result.map((r) => r.id));

  const toRemove = new Set<number>();

  // For each produced id, inline into all use sites
  producedBy.forEach(({ stmtIndex, stmt }, id) => {
    const sites = uses.get(id) ?? [];
    if (sites.length === 0) return; // nothing to inline
    // Replace consumer inputs with inline expression in all sites
    for (const site of sites) {
      const consumer = body[site.stmtIndex];
      const inline: IRInlineExpr = { kind: 'inline', op: stmt };
      const inp = consumer.inputs.find(i => i.name === site.inputName);
      if (inp) inp.value = inline;
    }
    // Remove producer if it doesn't contribute to result
    if (!resultIds.has(id)) {
      toRemove.add(stmtIndex);
    }
  });

  const newBody: IRStmt[] = [];
  for (let i = 0; i < body.length; i++) {
    if (!toRemove.has(i)) newBody.push(body[i]);
  }

  // Return new function object with transformed body
  return { ...fn, body: newBody };
}

// Inlines the immediately previous instruction into the current one
// if its single output is used exactly once (in the current instruction)
// and that value is not part of function result. Side-effects are allowed
// and are represented transparently in pseudo-code.
export function inlinePrevSingleUse(fn: IRFunction): IRFunction {
  let body: IROpPrim[] = fn.body.slice();
  const resultIds = new Set(fn.result.map((r) => r.id));

  const countUses = (b: IROpPrim[]): Map<string, number> => {
    const cnt: Map<string, number> = new Map();
    for (let i = 0; i < b.length; i++) {
      const st = b[i];
      for (const { value: a } of st.inputs) {
        if ((a as any).kind === 'inline') continue;
        const id = (a as IRValueRef).id;
        cnt.set(id, (cnt.get(id) ?? 0) + 1);
      }
    }
    return cnt;
  };

  let changed = true;
  while (changed) {
    changed = false;
    const uses = countUses(body);
    for (let i = 1; i < body.length; i++) {
      const prev = body[i - 1];
      const curr = body[i];
      const outs = prev.outputs.map(o => o.value);
      if (outs.length !== 1) continue;
      const id = outs[0].id;
      if (resultIds.has(id)) continue; // don't remove a producer contributing to result
      const totalUses = uses.get(id) ?? 0;
      if (totalUses !== 1) continue;
      // Check curr uses this id in one of its inputs
      let foundInputName: string | null = null;
      for (const { name, value: a } of curr.inputs) {
        if ((a as any).kind === 'inline') continue;
        if ((a as IRValueRef).id === id) { foundInputName = name; break; }
      }
      if (!foundInputName) continue;
      // Inline
      const inline: IRInlineExpr = { kind: 'inline', op: prev };
      const inp = curr.inputs.find(i => i.name === foundInputName);
      if (inp) inp.value = inline;
      // Remove prev from body
      body.splice(i - 1, 1);
      // Move index back to re-check new adjacency around position i-1
      changed = true;
      break;
    }
  }

  return { ...fn, body };
}
