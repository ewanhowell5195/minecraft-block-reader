import test from "node:test"
import assert from "node:assert/strict"
import { read, parseState, normState } from "../src/index.js"
import { writeNBT, packLitematic, gzip, B, Sh, I, D, Str, bytes, ints, longs, list, comp } from "./build.js"

const pos3 = (x, y, z) => list([I(x), I(y), I(z)])

// the js reader is only reached when the wasm cannot load, so it is compared
// against the wasm one here rather than waiting for a user to find the drift
async function bothAgree(bytes, label) {
  const { readStructureJs } = await import("../src/js-reader.js")
  const js = await readStructureJs(bytes)
  assert.notEqual(js, null, `${label}: the js reader did not recognise it`)
  assert.deepEqual(js, await read(bytes), `${label}: the two readers disagree`)
  assert.deepEqual(Array.from(js.raw), Array.from((await read(bytes)).raw), `${label}: raw differs`)
}


function vanillaStructure() {
  return writeNBT(comp({
    size: pos3(2, 1, 1),
    palette: list([
      comp({ Name: Str("minecraft:stone") }),
      comp({ Name: Str("minecraft:oak_stairs"), Properties: comp({ facing: Str("north") }) })
    ]),
    blocks: list([
      comp({ state: I(0), pos: pos3(0, 0, 0) }),
      comp({ state: I(1), pos: pos3(1, 0, 0), nbt: comp({ id: Str("minecraft:chest") }) })
    ]),
    entities: list([
      comp({ pos: list([D(0.5), D(0), D(0.5)]), blockPos: pos3(0, 0, 0), nbt: comp({ id: Str("minecraft:pig") }) })
    ])
  }))
}

test("vanilla structure, old state fields fold forward", async () => {
  const s = await read(vanillaStructure())
  assert.deepEqual(s.size, [2, 1, 1])
  assert.deepEqual(s.palette, [
    { id: "minecraft:stone" },
    { id: "minecraft:oak_stairs", properties: { facing: "north" } }
  ])
  assert.equal(s.blocks.length, 2)
  assert.deepEqual(s.blocks[1].pos, [1, 0, 0])
  assert.equal(s.blocks[1].nbt.id, "minecraft:chest")
  assert.equal(s.entities.length, 1)
  assert.deepEqual(s.entities[0].pos, [0.5, 0, 0.5])
  assert.equal(s.entities[0].nbt.id, "minecraft:pig")
  await bothAgree(vanillaStructure(), "vanilla")
})

test("vanilla structure accepts gzip and new state fields", async () => {
  const raw = writeNBT(comp({
    size: pos3(1, 1, 1),
    palette: list([comp({ id: Str("minecraft:stone") })]),
    blocks: list([comp({ state: I(0), pos: pos3(0, 0, 0) })]),
    entities: list([])
  }))
  const s = await read(gzip(raw))
  assert.deepEqual(s.palette, [{ id: "minecraft:stone" }])
  await bothAgree(raw, "vanilla gzip")
})

test("vanilla structure reads the plural palettes form", async () => {
  const raw = writeNBT(comp({
    size: pos3(1, 1, 1),
    palettes: list([list([comp({ Name: Str("minecraft:dirt") })])]),
    blocks: list([comp({ state: I(0), pos: pos3(0, 0, 0) })]),
    entities: list([])
  }))
  const s = await read(raw)
  assert.deepEqual(s.palette, [{ id: "minecraft:dirt" }])
  await bothAgree(raw, "vanilla palettes")
})

test("litematic: packed blocks, tile entities, entities", async () => {
  // palette air/stone/chest, bits 2; stone at (0,0,0), chest at (1,0,0)
  const raw = writeNBT(comp({
    Regions: comp({
      main: comp({
        Position: comp({ x: I(0), y: I(0), z: I(0) }),
        Size: comp({ x: I(2), y: I(1), z: I(1) }),
        BlockStatePalette: list([
          comp({ Name: Str("minecraft:air") }),
          comp({ Name: Str("minecraft:stone") }),
          comp({ Name: Str("minecraft:chest"), Properties: comp({ facing: Str("north") }) })
        ]),
        BlockStates: longs(packLitematic([1, 2], 2)),
        TileEntities: list([
          comp({ x: I(1), y: I(0), z: I(0), id: Str("minecraft:chest"), Items: list([]) })
        ]),
        Entities: list([
          comp({ Pos: list([D(0.5), D(0), D(0.5)]), id: Str("minecraft:pig") })
        ])
      })
    })
  }))
  const s = await read(raw)
  assert.deepEqual(s.size, [2, 1, 1])
  assert.deepEqual(s.palette, [
    { id: "minecraft:stone" },
    { id: "minecraft:chest", properties: { facing: "north" } }
  ])
  const chest = s.blocks.find(b => b.state === 1)
  assert.deepEqual(chest.pos, [1, 0, 0])
  assert.equal(chest.nbt.id, "minecraft:chest")
  assert.equal(chest.nbt.x, undefined)
  assert.equal(s.entities.length, 1)
  assert.deepEqual(s.entities[0].pos, [0.5, 0, 0.5])
  await bothAgree(raw, "litematic")
})

test("litematic: negative region size still lands in bounds", async () => {
  const raw = writeNBT(comp({
    Regions: comp({
      main: comp({
        Position: comp({ x: I(5), y: I(0), z: I(5) }),
        Size: comp({ x: I(-2), y: I(1), z: I(-2) }),
        BlockStatePalette: list([comp({ Name: Str("minecraft:air") }), comp({ Name: Str("minecraft:stone") })]),
        BlockStates: longs(packLitematic([1, 1, 1, 1], 2)),
        TileEntities: list([
          comp({ x: I(1), y: I(0), z: I(1), id: Str("minecraft:chest") })
        ]),
        Entities: list([
          comp({ Pos: list([D(-0.5), D(0), D(-0.5)]), id: Str("minecraft:pig") })
        ])
      })
    })
  }))
  const s = await read(raw)
  assert.deepEqual(s.size, [2, 1, 2])
  assert.equal(s.blocks.length, 4)
  // tile entities anchor to the min corner, entities to Position (the max corner here)
  const chest = s.blocks.find(b => b.nbt)
  assert.deepEqual(chest.pos, [1, 0, 1])
  assert.deepEqual(s.entities[0].pos, [0.5, 0, 0.5])
  await bothAgree(raw, "litematic negative size")
})

test("schem v2: varints, block entities, entities", async () => {
  const raw = writeNBT(comp({
    Version: I(2),
    Width: Sh(2), Height: Sh(1), Length: Sh(1),
    Palette: comp({
      "minecraft:stone": I(0),
      "minecraft:chest[facing=north]": I(1),
      "minecraft:air": I(2)
    }),
    BlockData: bytes([0, 1]),
    BlockEntities: list([
      comp({ Pos: ints([1, 0, 0]), Id: Str("minecraft:chest"), Items: list([]) })
    ]),
    Entities: list([
      comp({ Pos: list([D(0.5), D(0), D(0.5)]), Id: Str("minecraft:pig") })
    ])
  }))
  const s = await read(raw)
  assert.deepEqual(s.size, [2, 1, 1])
  assert.deepEqual(s.palette, [
    { id: "minecraft:stone" },
    { id: "minecraft:chest", properties: { facing: "north" } }
  ])
  const chest = s.blocks.find(b => b.state === 1)
  assert.deepEqual(chest.pos, [1, 0, 0])
  assert.equal(chest.nbt.id, "minecraft:chest")
  assert.ok(chest.nbt.Items)
  assert.equal(s.entities.length, 1)
  assert.equal(s.entities[0].nbt.id, "minecraft:pig")
  await bothAgree(raw, "schem v2")
})

test("schem v3: nested Blocks, Data payloads", async () => {
  const raw = writeNBT(comp({
    Schematic: comp({
      Version: I(3),
      Width: Sh(1), Height: Sh(1), Length: Sh(1),
      Blocks: comp({
        Palette: comp({ "minecraft:chest": I(0) }),
        Data: bytes([0]),
        BlockEntities: list([
          comp({ Pos: ints([0, 0, 0]), Id: Str("minecraft:chest"), Data: comp({ Items: list([]) }) })
        ])
      }),
      Entities: list([
        comp({ Pos: list([D(0.5), D(0.5), D(0.5)]), Id: Str("minecraft:cow"), Data: comp({ Health: I(10) }) })
      ])
    })
  }))
  const s = await read(raw)
  assert.equal(s.blocks.length, 1)
  assert.equal(s.blocks[0].nbt.id, "minecraft:chest")
  assert.ok(s.blocks[0].nbt.Items)
  assert.equal(s.entities[0].nbt.id, "minecraft:cow")
  assert.equal(s.entities[0].nbt.Health, 10)
  await bothAgree(raw, "schem v3")
})

test("mcstructure: little-endian, waterlogging layer, block entities, entity origin", async () => {
  // 2x1x1: chest then water-logged fence; layer 1 waterlogs index 1
  const raw = writeNBT(comp({
    format_version: I(1),
    size: pos3(2, 1, 1),
    structure_world_origin: pos3(100, 64, 200),
    structure: comp({
      block_indices: list([
        list([I(0), I(1)]),
        list([I(-1), I(2)])
      ]),
      entities: list([
        comp({ Pos: list([{ t: 5, v: 101.5 }, { t: 5, v: 65 }, { t: 5, v: 200.5 }]), identifier: Str("minecraft:pig") })
      ]),
      palette: comp({
        default: comp({
          block_palette: list([
            comp({ name: Str("minecraft:chest"), states: comp({ facing_direction: I(2) }) }),
            comp({ name: Str("minecraft:oak_fence"), states: comp({}) }),
            comp({ name: Str("minecraft:water"), states: comp({}) })
          ]),
          block_position_data: comp({
            0: comp({ block_entity_data: comp({ id: Str("Chest") }) })
          })
        })
      })
    })
  }), { littleEndian: true })
  const s = await read(raw)
  assert.deepEqual(s.size, [2, 1, 1])
  assert.deepEqual(s.palette, [
    { id: "minecraft:chest", properties: { facing: "north" } },
    { id: "minecraft:oak_fence", properties: { waterlogged: "true" } }
  ])
  assert.equal(s.blocks[0].nbt.id, "Chest")
  assert.equal(s.entities.length, 1)
  assert.deepEqual(s.entities[0].pos, [1.5, 1, 0.5])
  await bothAgree(raw, "mcstructure")
})

test("read rejects bytes it can't place", async () => {
  await assert.rejects(read(new Uint8Array([1, 2, 3, 4])), /detect the file format/)
})

test("parseState and normState", () => {
  assert.deepEqual(parseState("stone"), { id: "minecraft:stone" })
  assert.deepEqual(parseState("mod:thing[a=1,b=two]"), { id: "mod:thing", properties: { a: "1", b: "two" } })
  assert.deepEqual(normState("minecraft:stone"), { id: "minecraft:stone" })
  assert.deepEqual(normState({ Name: "minecraft:stone", Properties: { lit: "true" } }), { id: "minecraft:stone", properties: { lit: "true" } })
  const already = { id: "minecraft:stone", properties: { lit: "true" } }
  assert.equal(normState(already), already)
})

test("1.9 structures have no palette, so packed numeric states build one", async () => {
  // the reader unpacks with ((state & 0xFFF) << 4 | state >> 12)
  const packed = id => I(((id & 15) << 12) | (id >> 4))
  const raw = writeNBT(comp({
    size: pos3(4, 1, 1),
    blocks: list([
      comp({ state: packed(16), pos: pos3(0, 0, 0) }),
      comp({ state: packed(16), pos: pos3(1, 0, 0) }),
      comp({ state: packed(17), pos: pos3(2, 0, 0) }),
      comp({ state: packed(800), pos: pos3(3, 0, 0) })
    ])
  }))
  const s = await read(raw)
  assert.deepEqual(s.palette, [
    { id: "minecraft:stone" },
    { id: "minecraft:granite" },
    { id: "minecraft:air" }
  ])
  assert.deepEqual(s.blocks.map(b => b.state), [0, 0, 1, 2])
})

test("1.9 skulls take their block from SkullType and Rot, not the state", async () => {
  const packed = id => I(((id & 15) << 12) | (id >> 4))
  const skull = (id, nbt) => comp(nbt
    ? { state: packed(id), pos: pos3(0, 0, 0), nbt: comp(nbt) }
    : { state: packed(id), pos: pos3(0, 0, 0) })
  const raw = writeNBT(comp({
    size: pos3(1, 1, 1),
    blocks: list([
      skull(2305, { SkullType: I(1), Rot: I(7) }),
      skull(2306, { SkullType: I(2) }),
      skull(2305, null)
    ])
  }))
  const s = await read(raw)
  assert.deepEqual(s.palette, [
    { id: "minecraft:wither_skeleton_skull", properties: { rotation: "7" } },
    { id: "minecraft:zombie_wall_head", properties: { facing: "north" } },
    { id: "minecraft:skeleton_skull", properties: { rotation: "0" } }
  ])
})

test("raw is the same blocks as a flat run, and stays out of the enumerable shape", async () => {
  const s = await read(vanillaStructure())
  assert.deepEqual(Object.keys(s), ["size", "palette", "blocks", "entities"])
  assert.equal(JSON.parse(JSON.stringify(s)).raw, undefined)
  assert.equal(s.raw.length, s.blocks.length * 4)
  for (let i = 0, j = 0; i < s.raw.length; i += 4, j++) {
    assert.equal(s.raw[i], s.blocks[j].state)
    assert.deepEqual([s.raw[i + 1], s.raw[i + 2], s.raw[i + 3]], s.blocks[j].pos)
  }
})

test("the wasm reader is the one answering", async () => {
  const { readStructureFast } = await import("../src/fast.js")
  assert.notEqual(await readStructureFast(vanillaStructure()), null,
    "the wasm module did not load, so every read silently fell back to js")
})

test("the built wasm is not older than the rust it came from", async t => {
  const { statSync, readdirSync, existsSync } = await import("node:fs")
  // rust/ is not published, so there is nothing to be out of step with
  if (!existsSync(new URL("../rust/src", import.meta.url))) return t.skip("no rust sources")

  const newest = dir => Math.max(...readdirSync(dir, { withFileTypes: true }).map(e => {
    const p = dir + "/" + e.name
    return e.isDirectory() ? newest(p) : statSync(p).mtimeMs
  }))
  const src = Math.max(
    newest(new URL("../rust/src", import.meta.url).pathname.slice(1)),
    statSync(new URL("../rust/Cargo.toml", import.meta.url).pathname.slice(1)).mtimeMs
  )
  const built = statSync(new URL("../wasm/minecraft_block_reader_bg.wasm", import.meta.url).pathname.slice(1)).mtimeMs
  assert.ok(built >= src, "rust/ has changed since wasm/ was built, run npm run build:wasm")
})


test("blockNbt reaches the block entities without building the objects", async () => {
  const s = await read(vanillaStructure())
  const withNbt = s.blocks.flatMap((b, i) => b.nbt ? [[i, b.nbt]] : [])
  assert.deepEqual([...s.blockNbt.entries()], withNbt)
  assert.equal(JSON.parse(JSON.stringify(s)).blockNbt, undefined)

  // the js reader has to agree, since it builds the map the other way round
  const { readStructureJs } = await import("../src/js-reader.js")
  const js = await readStructureJs(vanillaStructure())
  assert.deepEqual([...js.blockNbt.entries()], withNbt)
})
