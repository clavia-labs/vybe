import { state } from "../src/index.js";

const s = state({
  task:
    process.argv.slice(2).join(" ") ||
    "Write one short sentence about a virtual machine that samples its next instruction.",
});
console.log(await s.infer`Complete this text generation task: ${s.ref.task}`);
