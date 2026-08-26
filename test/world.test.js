import test from "node:test"
import assert from "node:assert/strict"
import { read, chunkBlocks, readNBT } from "../src/index.js"
import { writeNBT, packChunk, packLitematic, buildRegion, buildZip, gzip, bytes, B, I, D, Str, list, comp, longs } from "./build.js"

// chunk (2,-1): stone at world (33, 65, -16) with a chest block entity there
function chunkNbt() {
  const indices = new Array(4096).fill(0)
  indices[(1 << 8) | (0 << 4) | 1] = 1
  return writeNBT(comp({
    xPos: I(2), zPos: I(-1),
    sections: list([
      comp({
        Y: B(4),
        block_states: comp({
          palette: list([
            comp({ Name: Str("minecraft:air") }),
            comp({ Name: Str("minecraft:stone") })
          ]),
          data: longs(packChunk(indices, 4))
        })
      })
    ]),
    block_entities: list([
      comp({ x: I(33), y: I(65), z: I(-16), id: Str("minecraft:chest") })
    ])
  }))
}

// chunk (2,-1) sits at index 994 in region r.0.-1
const CHUNK_INDEX = 31 * 32 + 2

test("region file: scan, chunk decode, block entities, extent", async () => {
  const world = await read(buildRegion(new Map([[CHUNK_INDEX, chunkNbt()]])), { region: [0, -1] })
  assert.equal(world.chunks.length, 1)
  assert.deepEqual([world.chunks[0].cx, world.chunks[0].cz], [2, -1])
  const nbt = await world.chunk(world.chunks[0])
  assert.equal(nbt.xPos, 2)
  const { palette, blocks } = chunkBlocks(nbt)
  assert.deepEqual(palette, [{ id: "minecraft:stone" }])
  assert.equal(blocks.length, 1)
  assert.deepEqual(blocks[0].pos, [33, 65, -16])
  assert.equal(blocks[0].nbt.id, "minecraft:chest")
  assert.equal(blocks[0].nbt.x, undefined)
  assert.deepEqual(await world.chunkExtent(world.chunks[0]), { top: 79, bottom: 64 })
})

test("chunkBlocks: y range and includeAir", async () => {
  const world = await read(buildRegion(new Map([[CHUNK_INDEX, chunkNbt()]])), { region: [0, -1] })
  const nbt = await world.chunk(world.chunks[0])
  assert.equal(chunkBlocks(nbt, { yMax: 64 }).blocks.length, 0)
  assert.equal(chunkBlocks(nbt, { yMin: 65, yMax: 65 }).blocks.length, 1)
  assert.equal(chunkBlocks(nbt, { includeAir: true }).blocks.length, 4096)
})

function worldZip() {
  const levelDat = gzip(writeNBT(comp({ Data: comp({ LevelName: Str("Test World") }) })))
  const region = buildRegion(new Map([[CHUNK_INDEX, chunkNbt()]]))
  const entityRegion = buildRegion(new Map([[CHUNK_INDEX, writeNBT(comp({
    Entities: list([comp({ Pos: list([D(33.5), D(70), D(-15.5)]), id: Str("minecraft:cow") })])
  }))]]))
  const netherRegion = buildRegion(new Map([[0, writeNBT(comp({
    xPos: I(0), zPos: I(0),
    sections: list([comp({
      Y: B(0),
      block_states: comp({ palette: list([comp({ Name: Str("minecraft:netherrack") })]) })
    })])
  }))]]))
  const structure = writeNBT(comp({
    size: list([I(1), I(1), I(1)]),
    palette: list([comp({ Name: Str("minecraft:dirt") })]),
    blocks: list([comp({ state: I(0), pos: list([I(0), I(0), I(0)]) })]),
    entities: list([])
  }))
  return buildZip([
    { name: "world/level.dat", data: levelDat },
    { name: "world/region/r.0.-1.mca", data: region },
    { name: "world/entities/r.0.-1.mca", data: entityRegion },
    { name: "world/DIM-1/region/r.0.0.mca", data: netherRegion },
    { name: "world/generated/minecraft/structures/test.nbt", data: structure }
  ])
}

test("world zip: dimensions, name, chunks, entities, generated structures", async () => {
  const world = await read(worldZip())
  assert.equal(world.name, "Test World")
  assert.deepEqual(world.dimensions, ["overworld", "the_nether"])
  assert.equal(world.dimension, "overworld")
  assert.equal(world.chunks.length, 1)

  const { blocks } = chunkBlocks(await world.chunk(world.chunks[0]))
  assert.deepEqual(blocks[0].pos, [33, 65, -16])

  const { entities } = chunkBlocks(await world.chunk(world.chunks[0]))
  assert.equal(entities.length, 1)
  assert.equal(entities[0].nbt.id, "minecraft:cow")
  assert.deepEqual(entities[0].pos, [33.5, 70, -15.5])

  assert.deepEqual(world.structures, ["minecraft/test"])
  const s = await world.structure("minecraft/test")
  assert.deepEqual(s.palette, [{ id: "minecraft:dirt" }])

  const nether = await world.setDimension("the_nether")
  assert.equal(nether.dimension, "the_nether")
  assert.equal(nether.chunks.length, 1)
  const nc = chunkBlocks(await nether.chunk(nether.chunks[0]), { includeAir: true })
  assert.deepEqual(nc.palette, [{ id: "minecraft:netherrack" }])
})

test("world zip accepts a Blob", async () => {
  const world = await read(new Blob([worldZip()]))
  assert.equal(world.name, "Test World")
  assert.equal(world.chunks.length, 1)
  const { blocks } = chunkBlocks(await world.chunk(world.chunks[0]))
  assert.equal(blocks.length, 1)
})

test("readNBT: skip set, endianness, long arrays as lo/hi pairs", async () => {
  const raw = writeNBT(comp({
    keep: I(7),
    Heightmaps: comp({ deep: list([I(1), I(2)]) }),
    big: { t: 4, v: 2n ** 40n },
    packed: longs([1n, -1n])
  }))
  const root = await readNBT(raw, { skip: new Set(["Heightmaps"]) })
  assert.equal(root.keep, 7)
  assert.equal(root.Heightmaps, undefined)
  assert.equal(root.big, 2n ** 40n)
  assert.deepEqual(Array.from(root.packed), [1, 0, 0xFFFFFFFF, 0xFFFFFFFF])

  const le = await readNBT(writeNBT(comp({ v: I(258) }), { littleEndian: true }), { littleEndian: true })
  assert.equal(le.v, 258)
})

test("world.blocks: box trim, shared palette, entities, chunk accounting", async () => {
  const outdated = writeNBT(comp({ Level: comp({ xPos: I(3), zPos: I(-1) }) }))
  const zip = buildZip([
    { name: "world/region/r.0.-1.mca", data: buildRegion(new Map([[CHUNK_INDEX, chunkNbt()], [31 * 32 + 3, outdated]])) },
    { name: "world/entities/r.0.-1.mca", data: buildRegion(new Map([[CHUNK_INDEX, writeNBT(comp({
      Entities: list([
        comp({ Pos: list([D(33.5), D(70), D(-15.5)]), id: Str("minecraft:cow") }),
        comp({ Pos: list([D(28.5), D(70), D(-15.5)]), id: Str("minecraft:pig") })
      ])
    }))]])) }
  ])
  const world = await read(zip)

  // box spans the stone chunk, the outdated chunk, and two never-generated ones
  const r = await world.blocks({ x0: 32, z0: -17, x1: 50, z1: -15 })
  assert.deepEqual(r.chunks, { read: 1, missing: 2, outdated: 1 })
  assert.deepEqual(r.palette, [{ id: "minecraft:stone" }])
  assert.equal(r.blocks.length, 1)
  assert.deepEqual(r.blocks[0].pos, [33, 65, -16])
  assert.equal(r.blocks[0].nbt.id, "minecraft:chest")
  assert.equal(r.entities.length, 1)
  assert.equal(r.entities[0].nbt.id, "minecraft:cow")

  // trim: same chunks, box just past the stone
  const r2 = await world.blocks({ x0: 34, z0: -17, x1: 50, z1: -15 })
  assert.equal(r2.blocks.length, 0)
  assert.equal(r2.chunks.read, 1)

  // entirely outside the world
  const r3 = await world.blocks({ x0: 1000, z0: 1000, x1: 1010, z1: 1010 })
  assert.deepEqual(r3, { palette: [], blocks: [], entities: [], chunks: { read: 0, missing: 4, outdated: 0 } })

  // y bounds cut the block out
  const r4 = await world.blocks({ x0: 32, z0: -17, x1: 50, z1: -15, y0: 0, y1: 60 })
  assert.equal(r4.blocks.length, 0)
})

test("world sources: Buffer, ArrayBuffer, DataView", async () => {
  const zip = worldZip()
  const { Buffer } = await import("node:buffer")
  for (const src of [Buffer.from(zip), zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength), new DataView(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength))]) {
    const world = await read(src)
    assert.equal(world.name, "Test World")
    assert.equal(world.chunks.length, 1)
  }
})

test("read() detects every format from bytes alone", async () => {
    const vanilla = writeNBT(comp({
    size: list([I(1), I(1), I(1)]),
    palette: list([comp({ Name: Str("minecraft:dirt") })]),
    blocks: list([comp({ state: I(0), pos: list([I(0), I(0), I(0)]) })]),
    entities: list([])
  }))
  assert.equal((await read(vanilla)).palette[0].id, "minecraft:dirt")
  assert.equal((await read(gzip(vanilla))).palette[0].id, "minecraft:dirt")

  const lit = writeNBT(comp({
    Regions: comp({ main: comp({
      Position: comp({ x: I(0), y: I(0), z: I(0) }),
      Size: comp({ x: I(1), y: I(1), z: I(1) }),
      BlockStatePalette: list([comp({ Name: Str("minecraft:stone") })]),
      BlockStates: longs(packLitematic([0], 2))
    }) })
  }))
  assert.equal((await read(lit)).palette[0].id, "minecraft:stone")

  const schem = writeNBT(comp({
    Version: I(2), Width: { t: 2, v: 1 }, Height: { t: 2, v: 1 }, Length: { t: 2, v: 1 },
    Palette: comp({ "minecraft:stone": I(0) }),
    BlockData: bytes([0])
  }))
  assert.equal((await read(schem)).palette[0].id, "minecraft:stone")

  const mcs = writeNBT(comp({
    size: list([I(1), I(1), I(1)]),
    structure_world_origin: list([I(0), I(0), I(0)]),
    structure: comp({
      block_indices: list([list([I(0)]), list([I(-1)])]),
      entities: list([]),
      palette: comp({ default: comp({ block_palette: list([comp({ name: Str("minecraft:stone"), states: comp({}) })]), block_position_data: comp({}) }) })
    })
  }), { littleEndian: true })
  assert.equal((await read(mcs)).palette[0].id, "minecraft:stone")

  const region = buildRegion(new Map([[CHUNK_INDEX, chunkNbt()]]))
  const worldFromRegion = await read(region, { region: [0, -1] })
  assert.equal(worldFromRegion.chunks.length, 1)
  assert.deepEqual([worldFromRegion.chunks[0].cx, worldFromRegion.chunks[0].cz], [2, -1])

  // nameless region files sniff by their sector table and default to region 0,0
  const nameless = await read(region)
  assert.equal(nameless.chunks.length, 1)
  assert.deepEqual([nameless.chunks[0].cx, nameless.chunks[0].cz], [2, 31])

  const zip = worldZip()
  const worldFromZip = await read(zip)
  assert.equal(worldFromZip.name, "Test World")
  assert.equal((await read(new Blob([zip]))).name, "Test World")

  const opened = await read(new Blob([zip]))
  const r1 = await opened.blocks({ x0: 32, z0: -17, x1: 34, z1: -15 })
  assert.equal(r1.blocks.length, 1)
})

test("world.file reads any save file", async () => {
  const world = await read(worldZip())
  const level = await readNBT(await world.file("level.dat"))
  assert.equal(level.Data.LevelName, "Test World")
  assert.equal(await world.file("nope.dat"), null)
})

test("readNBT detects endianness, and the buffer check settles it", async () => {
  const be = writeNBT(comp({ hello: Str("world"), n: I(258) }))
  const le = writeNBT(comp({ hello: Str("world"), n: I(258) }), { littleEndian: true })
  assert.equal((await readNBT(be)).n, 258)
  assert.equal((await readNBT(le)).n, 258)
  assert.equal((await readNBT(gzip(le))).n, 258)

  // an explicit flag still wins, right or wrong
  assert.equal((await readNBT(le, { littleEndian: true })).n, 258)
  await assert.rejects(readNBT(le, { littleEndian: false }))

  // trailing bytes: the parse that consumes the whole buffer is preferred
  const padded = new Uint8Array(le.length + 4)
  padded.set(le)
  assert.equal((await readNBT(padded)).n, 258)

  await assert.rejects(readNBT(new Uint8Array([10, 0, 0, 99])), /not NBT data/)
})

// a 17-entry palette forces 5-bit indices, which actually cross long
// boundaries in the spanning era (4-bit ones never do)
function levelChunkNbt({ dataVersion, pack, xPos }) {
  const indices = new Array(4096).fill(0)
  indices[(1 << 8) | (1 << 4) | 1] = 1
  indices[(1 << 8) | (0 << 4) | 1] = 2
  indices[4095] = 16
  return writeNBT(comp({
    DataVersion: I(dataVersion),
    Level: comp({
      xPos: I(xPos), zPos: I(-1),
      Sections: list([
        comp({
          Y: B(4),
          Palette: list([
            comp({ Name: Str("minecraft:air") }),
            ...Array.from({ length: 16 }, (_, i) => comp({ Name: Str("minecraft:block" + i) }))
          ]),
          BlockStates: longs(pack(indices, 5))
        })
      ]),
      TileEntities: list([comp({ x: I(xPos * 16 + 1), y: I(65), z: I(-16), id: Str("minecraft:chest") })]),
      Entities: list([comp({ Pos: list([D(xPos * 16 + 1.5), D(70), D(-15.5)]), id: Str("minecraft:cow") })])
    })
  }))
}

test("1.13-1.17 Level chunks fold to the current shape", async () => {
  const spanning = levelChunkNbt({ dataVersion: 2230, pack: packLitematic, xPos: 2 })
  const aligned = levelChunkNbt({ dataVersion: 2586, pack: packChunk, xPos: 3 })
  const numeric = writeNBT(comp({
    DataVersion: I(1343),
    Level: comp({
      xPos: I(4), zPos: I(-1),
      Sections: list([comp({ Y: B(4), Blocks: bytes(new Array(4096).fill(1)), Data: bytes(new Array(2048).fill(0)) })])
    })
  }))
  const world = await read(buildRegion(new Map([
    [CHUNK_INDEX, spanning], [31 * 32 + 3, aligned], [31 * 32 + 4, numeric]
  ])), { region: [0, -1] })
  assert.equal(world.chunks.length, 3)

  const old = world.chunks.find(c => c.cx === 2)
  const nbt = await world.chunk(old)
  assert.equal(nbt.xPos, 2)
  const { palette, blocks, entities } = chunkBlocks(nbt)
  assert.equal(blocks.length, 3)
  const at = pos => blocks.find(b => String(b.pos) === String(pos))
  assert.equal(palette[at([33, 65, -15]).state].id, "minecraft:block0")
  assert.equal(palette[at([47, 79, -1]).state].id, "minecraft:block15")
  assert.equal(at([33, 65, -16]).nbt.id, "minecraft:chest")
  assert.equal(entities.length, 1)
  assert.equal(entities[0].nbt.id, "minecraft:cow")
  assert.deepEqual(await world.chunkExtent(old), { top: 79, bottom: 64 })

  const a = chunkBlocks(await world.chunk(world.chunks.find(c => c.cx === 3)))
  assert.equal(a.blocks.length, 3)
  assert.equal(a.palette[a.blocks.find(b => String(b.pos) === String([63, 79, -1])).state].id, "minecraft:block15")

  // the numeric pre-flattening chunk stays outdated
  const r = await world.blocks({ x0: 32, z0: -17, x1: 79, z1: -1 })
  assert.deepEqual(r.chunks, { read: 2, missing: 3, outdated: 1 })
})

test("world zip: vanilla and datapack dimensions coexist", async () => {
  const chunk = (id, x = 0, z = 0) => buildRegion(new Map([[x + z * 32, writeNBT(comp({
    xPos: I(x), zPos: I(z),
    sections: list([comp({
      Y: B(0),
      block_states: comp({ palette: list([comp({ Name: Str(id) })]) })
    })])
  }))]]))
  const zip = buildZip([
    { name: "world/region/r.0.0.mca", data: chunk("minecraft:stone") },
    { name: "world/DIM-1/region/r.0.0.mca", data: chunk("minecraft:netherrack") },
    { name: "world/dimensions/mydata/weird/region/r.0.0.mca", data: chunk("minecraft:sculk") }
  ])
  const world = await read(zip)
  assert.deepEqual(world.dimensions, ["overworld", "the_nether", "mydata:weird"])
  assert.equal(world.dimension, "overworld")
  await world.setDimension("mydata:weird")
  const { palette } = chunkBlocks(await world.chunk(world.chunks[0]), { includeAir: true })
  assert.deepEqual(palette, [{ id: "minecraft:sculk" }])
})

test("onProgress counts completions and reaches the total", async () => {
  const opens = []
  const world = await read(worldZip(), { onProgress: (d, t) => opens.push([d, t]) })
  assert.deepEqual(opens.at(-1), [1, 1])

  const reads = []
  await world.blocks({ x0: 32, z0: -17, x1: 50, z1: -15 }, (d, t) => reads.push([d, t]))
  assert.equal(reads.length, 4)
  assert.deepEqual(reads.at(-1), [4, 4])
  assert.ok(reads.every(([d, t], i) => d === i + 1 && t === 4))
})

test("unsupported zip compression methods throw instead of returning garbage", async () => {
  const zip = buildZip([
    { name: "world/region/r.0.-1.mca", data: buildRegion(new Map([[CHUNK_INDEX, chunkNbt()]])), method: 12 }
  ])
  await assert.rejects(read(zip), /unsupported zip compression method 12/)
})

test("readNBT: skip and only, in any key-set shape", async () => {
  const raw = writeNBT(comp({ a: I(1), b: I(2), deep: comp({ a: I(9), c: I(3) }) }))
  const all = { a: 1, b: 2, deep: { a: 9, c: 3 } }
  assert.deepEqual(await readNBT(raw), all)

  // a name, a list, or a Set all mean the same
  for (const form of ["a", ["a"], new Set(["a"])]) {
    assert.deepEqual(await readNBT(raw, { skip: form }), { b: 2, deep: { c: 3 } })
  }

  // skip reaches every depth; only filters the root
  assert.deepEqual(await readNBT(raw, { only: ["a", "deep"] }), { a: 1, deep: { a: 9, c: 3 } })
  assert.deepEqual(await readNBT(raw, { only: "deep", skip: "c" }), { deep: { a: 9 } })
  assert.deepEqual(await readNBT(raw, { only: "nothing_matches" }), {})
})
