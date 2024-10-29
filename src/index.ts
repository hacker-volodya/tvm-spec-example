import { BOC } from "ton3-core"
import * as fs from 'fs'
import { Continuation } from "./continuation";


const slice = BOC.from(new Uint8Array(fs.readFileSync(process.argv[2]))).root[0].slice();

console.log(Continuation.decompile(slice).dump())