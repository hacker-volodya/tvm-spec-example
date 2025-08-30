import { Decompiler } from "./decompiler";

const input = process.argv[2];
if (!input) {
    console.error("Usage: node dist/index.js <path-to-boc>");
    process.exit(1);
}

const decomp = new Decompiler();
const program = decomp.decompileFile(input);
console.log(decomp.format(program));
