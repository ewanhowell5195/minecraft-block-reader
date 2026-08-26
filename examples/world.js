import fs from "node:fs"
import { read, chunkBlocks } from "../src/index.js"

const file = process.argv[2]
if (!file) {
  console.log("usage: node examples/world.js <world.zip|r.x.z.mca>")
  process.exit(1)
}

const region = file.match(/r\.(-?\d+)\.(-?\d+)\.mca$/i)
const world = await read(await fs.openAsBlob(file), { region: region && [Number(region[1]), Number(region[2])] })

if (world.name) console.log("world:", world.name)
if (world.dimensions.length) console.log("dimensions:", world.dimensions.join(", "))
console.log("chunks:", world.chunks.length)
if (world.structures.length) console.log("generated structures:", world.structures.length)

for (const chunk of world.chunks) {
  const nbt = await world.chunk(chunk)
  const { palette, blocks } = chunkBlocks(nbt)
  if (!blocks.length) continue
  console.log(`\nchunk ${chunk.cx},${chunk.cz}: ${blocks.length} blocks, ${palette.length} palette entries`)
  console.log("y extent:", JSON.stringify(await world.chunkExtent(chunk)))
  const counts = new Map()
  for (const b of blocks) counts.set(palette[b.state].id, (counts.get(palette[b.state].id) ?? 0) + 1)
  for (const [id, n] of Array.from(counts).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    console.log(`  ${String(n).padStart(6)}  ${id}`)
  }
  break
}
