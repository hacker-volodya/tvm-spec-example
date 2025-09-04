import fs from 'fs';
import path from 'path';
import { Decompiler } from '../../src/decompiler';
import { compileFuncToSlice, FuncTestInput, FuncTestOptions } from '../helpers/func';

function loadTestSourcesSync(): { entries: { name: string; content: string }[]; sources: Record<string, string> } {
  const dir = path.join(__dirname, '__testdata__');
  const entries = fs
    .readdirSync(dir)
    .map((name) => ({ name, content: fs.readFileSync(path.join(dir, name), 'utf8') }));

  // Build a sources map keyed by include-friendly names (basenames)
  const sources: Record<string, string> = Object.fromEntries(entries.map(({ name, content }) => [name, content]));

  return { entries, sources };
}

// Load synchronously at module scope so test.each has data immediately
const loaded = loadTestSourcesSync();
const entries = loaded.entries
  // compile only files that define a `main` entry
  .filter((e) => /(^|\W)main\s*\(/m.test(e.content))
  .map((x) => x.name);
const sources = loaded.sources;

describe('Func → Decompiler → testdata snapshots', () => {
  // Some programs are quite large; bump timeout
  jest.setTimeout(30_000);

  test.each(entries)('decompile %s', async (name) => {
    const opts: FuncTestOptions = { targets: [name] };
    const code = await compileFuncToSlice(sources as FuncTestInput, opts);
    const d = new Decompiler();
    const out = d.format(d.decompileSlice(code));
    expect(out).toMatchSnapshot(name);
  });
});
