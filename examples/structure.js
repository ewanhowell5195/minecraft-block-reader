import fs from "node:fs"
import { read, structureName } from "../src/index.js"

const file = process.argv[2]
if (!file) {
  console.log("usage: node examples/structure.js <file.nbt|.litematic|.schem|.mcstructure>")
  process.exit(1)
}

const s = await read(fs.readFileSync(file), { name: file })

console.log(structureName(file.split(/[\\/]/).pop()))
console.log("size:", s.size.join(" x "))
console.log("blocks:", s.blocks.length, "| palette:", s.palette.length, "| entities:", s.entities.length)

const counts = new Map()
for (const b of s.blocks) {
  const id = s.palette[b.state].id
  counts.set(id, (counts.get(id) ?? 0) + 1)
}
console.log("\ntop blocks:")
for (const [id, n] of Array.from(counts).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${String(n).padStart(6)}  ${id}`)
}

const withNbt = s.blocks.filter(b => b.nbt)
if (withNbt.length) console.log("\nblock entities:", withNbt.length, "e.g.", withNbt[0].nbt.id, "at", withNbt[0].pos.join(","))
for (const e of s.entities.slice(0, 5)) {
  console.log("entity:", e.nbt.id ?? e.nbt.identifier, "at", e.pos.map(v => Math.round(v * 10) / 10).join(","))
}
