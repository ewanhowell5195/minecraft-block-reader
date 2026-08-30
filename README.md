# minecraft-block-reader

Read blocks, block states, and entities from Minecraft structure files and world saves.
Works in Node.js and the browser, with no dependencies.

[![npm version](https://badge.fury.io/js/minecraft-block-reader.svg)](https://www.npmjs.com/package/minecraft-block-reader)
[![jsDelivr](https://data.jsdelivr.com/v1/package/npm/minecraft-block-reader/badge)](https://www.jsdelivr.com/package/npm/minecraft-block-reader)
[![License: MPL 2.0](https://img.shields.io/badge/License-MPL_2.0-brightgreen.svg)](https://opensource.org/licenses/MPL-2.0)

## Features

* Reads structure files: `.nbt`, `.litematic`, `.schem`, and `.mcstructure`
* Reads world saves: a world folder as a `.zip`, or a single `.mca` region file
* One `read` function for every format, with one output shape
* Block entity nbt attached to its block, entities in a list of their own
* Lazy world reading: pass a `Blob` and multi-GB worlds are read in pieces, never loaded whole

## Install

For Node.js, or the browser through a bundler:

```bash
npm install minecraft-block-reader
```

Or in the browser, import it straight from a [CDN](https://www.jsdelivr.com/package/npm/minecraft-block-reader):

```js
import { read } from "https://cdn.jsdelivr.net/npm/minecraft-block-reader/+esm"
```

On Vite's dev server the WebAssembly module fails to load and the reader silently falls back to its slower JavaScript path. Exclude the library from pre-bundling:

```js
// vite.config.js
export default defineConfig({
  optimizeDeps: {
    exclude: ["minecraft-block-reader"]
  }
})
```

Vite builds are unaffected. Reading inside a web worker also needs `worker: { format: "es" }`, since the default `iife` format cannot code-split. Other bundlers may need their own equivalent.

## Quick Start

`read` takes any supported file and works out what it is. Structure files come back as structures, saves as worlds:

```js
import { read } from "minecraft-block-reader"

const structure = await read(bytes)   // .nbt, .litematic, .schem, or .mcstructure
const world = await read(blob)        // a world zip or region file
```

Every structure comes back in the same shape:

```js
{
  size: [x, y, z],
  palette: [{ id: "minecraft:oak_stairs", properties: { facing: "north", … } }, …],
  blocks: [{ state: 0, pos: [x, y, z], nbt: { … } }, …],   // nbt only on block entities
  entities: [{ pos: [x, y, z], nbt: { … } }, …]
}
```

And a world reads only what you ask for:

```js
const { palette, blocks, entities } = await world.blocks({ x0: -64, y0: 60, z0: -64, x1: 64, y1: 100, z1: 64 })
```

### raw

Every result also carries `raw`, the same blocks as one flat `Int32Array` of `[state, x, y, z, state, x, y, z, …]`. `blocks` is built from it only if something reads it, and for millions of blocks those objects cost far more than the parse does, so stay on `raw` if you can:

```js
const { palette, raw } = await world.blocks(box)
for (let i = 0; i < raw.length; i += 4) {
  const state = palette[raw[i]], x = raw[i + 1], y = raw[i + 2], z = raw[i + 3]
}
```

`blockNbt` is a `Map` from a block's index in `raw` to its nbt, so `raw` can reach block entities without the objects.

## Documentation

The full export list:

| Export | |
|---|---|
| [`read(src, options)`](#readsrc-options) | Reads any supported file. Structure files give a structure, saves give a world |
| [`chunkBlocks(nbt, options)`](#worlds) | The blocks in a chunk, from its NBT |
| [`readNBT(bytes, options)`](#nbt) | Reads NBT into an object |
| [`parseState(str)`](#block-states) | A block state string as `{ id, properties }` |
| [`normState(v)`](#block-states) | Converts an older block state shape to the current one |
| [`AIR`, `REAL_AIR`](#block-states) | Regexes that match air ids |

### read(src, options)

`src` is the file: a `Buffer`, `Uint8Array`, `ArrayBuffer`, or `Blob`. Pass a `Blob` (a browser `File`, or `fs.openAsBlob(path)` in node) and a world is read straight off disk in pieces, so multi-GB worlds never load whole.

All options are optional:

| Option | Description |
|---|---|
| `region` | A lone region file's coordinates as `[x, z]` (the `r.x.z.mca` numbers), defaulting to `[0, 0]` |
| `dimension` | Worlds: the dimension to open on, instead of the overworld |
| `onProgress` | Worlds: called with `(done, total)` while the regions are scanned |

The format is worked out from the bytes. Gzip is unpacked wherever it turns up, and Bedrock block states are mapped as closely as they can be.

`size` is how big the build actually is. Litematic, schem and mcstructure files are trimmed to the blocks they contain. Vanilla `.nbt` files keep the size they declare.

Vanilla `.nbt` files read from any version, including the 1.9-era format, whose numeric ids come back as the block states they became.

### Worlds

Opening a world only scans it. Blocks are read on demand, through the handle `read` gives back. Chunks from 1.13+ are supported.

| API | Description |
|---|---|
| `world.name` | The level name |
| `world.blocks(box, onProgress?)` | The blocks in a box, given as `{ x0, y0, z0, x1, y1, z1, includeAir }`. Every side is inclusive and the y bounds are optional. Comes back with one palette, the entities in the box, and `chunks: { read, missing, outdated }` |
| `world.chunks` | Every chunk the save has on disk, as `{ cx, cz, region, index }` |
| `world.chunk(c)` | A chunk's raw NBT, including its entities |
| `world.chunkExtent(c, { yMin, yMax })` | The lowest and highest y the chunk has a block at, as `{ top, bottom }`, or `null` if it has none. Much cheaper than reading the chunk. The optional y bounds limit the check to that range |
| `world.chunkBlocks(c, { yMin, yMax, includeAir })` | The blocks in a single chunk, or `null` if the chunk is missing or too old |
| `world.chunkGrid(c, { yMin, yMax })` | [Every position in the chunk as one array](#chunkgrid), so a block can be looked up by its coordinates rather than searched for in a list |
| `world.dimension` | The current dimension id |
| `world.dimensions` | The dimension ids, e.g. `["overworld", "the_nether"]` |
| `world.setDimension(id, onProgress?)` | Switches the world to another dimension |
| `world.structures` | The names of the structure files in the world's `generated/` folder |
| `world.structure(rel)` | One of those structure files, read |
| `world.file(path)` | Any other file from the save (`level.dat`, map items, datapacks), as bytes |

`chunkBlocks` is also exported, for NBT you already have. Positions come back in world space:

```js
import { chunkBlocks } from "minecraft-block-reader"

for (const c of world.chunks) {
  const { palette, blocks, entities } = chunkBlocks(await world.chunk(c), { yMin: 0, yMax: 128 })
}
```

#### chunkGrid

`chunkBlocks` gives the blocks that are there as a list, along with the chunk's entities. `chunkGrid` gives an array with a slot for every position instead, air included, so coordinates index straight into it.

Reach for it when you need to ask what is at a position. Stay on `chunkBlocks` to walk the blocks that exist, or when you need the entities, which the grid does not carry.

`grid` is a `Uint16Array` of `256 * height` cells. A cell holds 0 for air, or a palette index with 1 added:

```js
const { palette, grid, blockEntities, empty } = await world.chunkGrid(c, { yMin: 60, yMax: 80 })

// x and z are 0-15 inside the chunk, y is absolute
const at = (x, y, z) => {
  const cell = grid[(y - 60) * 256 + z * 16 + x]
  return cell === 0 ? null : palette[cell - 1]
}

at(3, 64, 7)   // { id: "minecraft:dirt" }
at(3, 65, 7)   // { id: "minecraft:grass_block", properties: { snowy: "false" } }
at(3, 66, 7)   // null, air
```

`empty` is true when the y range held no blocks at all, so a whole tile of sky can be skipped without walking the cells.

`blockEntities` are the ones inside that y range, at world coordinates, since the grid cells only carry a palette index:

```js
blockEntities   // [{ x: 2493, y: 74, z: -1010, nbt: { id: "minecraft:beehive", … } }]
```

### NBT

```js
import { readNBT } from "minecraft-block-reader"

const root = await readNBT(bytes)
```

Reads Java (big-endian) and Bedrock (little-endian) NBT. The endianness is worked out from the bytes and gzip is unpacked on the way in. Longs come back as `BigInt`, long arrays as `Uint32Array` `[lo, hi]` pairs.

| Option | Description |
|---|---|
| `only` | Keep just these root keys |
| `skip` | Drop these keys, at any depth |
| `littleEndian` | Force the endianness instead of detecting it |

Pass `littleEndian` when you already know it, and detection is skipped.

#### Reading part of a file

`only` and `skip` leave out values you are never going to look at. Both take a name, a list of names, or a `Set`:

```js
{ only: "sections" }
{ only: ["sections", "block_entities"] }
{ skip: new Set(["block_light", "sky_light"]) }
```

They filter at different depths.

**`only` applies to the root.** Everything under a key it keeps is decoded in full:

```js
await readNBT(chunk, { only: ["sections", "xPos", "zPos"] })
// { sections: [ … ], xPos: -22, zPos: -29 }   whole sections, nothing else
```

**`skip` applies at every depth**, matching on name rather than path, so it drops a key wherever it appears:

```js
await readNBT(bytes, { skip: "Heightmaps" })
// { keep: 1, deep: { keep2: 2 } }   the nested Heightmaps went too
```

Be careful with a name the format reuses, `data` being the obvious one. The two combine, `only` choosing the branches and `skip` pruning within them.

Use them when a file is large or there are thousands of it. On a 19KB world chunk, dropping the lighting, biome and heightmap data takes a parse from 0.22ms to 0.15ms, around a third; for a single small file it is not worth the thought. Passing a `Set` avoids rebuilding one per call, which only matters in that thousands case.

### Block states

The helpers the readers use to produce the `{ id, properties }` shape.

`parseState` turns a block state string, the form used in commands, `.schem` palettes and datapacks, into that shape. An id with no namespace gets `minecraft:`, properties are always strings, and the key is left off when there are none:

```js
parseState("oak_stairs[facing=north]")  // { id: "minecraft:oak_stairs", properties: { facing: "north" } }
parseState("minecraft:stone")           // { id: "minecraft:stone" }
parseState("garbage!!")                 // { id: "minecraft:air" }   anything unparseable reads as air
```

`normState` takes a state in any form Minecraft has used and returns the current one. Values that are not block states come back untouched, so it is safe to map over mixed data:

```js
normState({ Name: "minecraft:chest", Properties: { facing: "north" } })
// { id: "minecraft:chest", properties: { facing: "north" } }

normState("minecraft:stone")        // { id: "minecraft:stone" }
normState({ id: "minecraft:stone" }) // unchanged
normState(42)                        // 42
```

`AIR` and `REAL_AIR` test whether an id is air. Both match with or without the namespace:

| | Matches |
|---|---|
| `AIR` | `air`, `cave_air`, `void_air`, `structure_void` |
| `REAL_AIR` | `air`, `cave_air`, `void_air` |

The difference is `structure_void`, which only exists in structure files. Use `AIR` when reading a structure and `REAL_AIR` for world data.

## Rust

The parsing is a Rust crate, which the WebAssembly module is built from. It works on its own:

```toml
[dependencies]
minecraft-block-reader = { git = "https://github.com/ewanhowell5195/minecraft-block-reader.git" }
```

```rust
use minecraft_block_reader::{read_any, BoxQuery, Region};

let structure = read_any(&bytes).unwrap();

let region = Region::new(std::fs::read("r.4.-2.mca")?);
let mut query = BoxQuery::new([2048.0, 60.0, -1024.0], [2300.0, 90.0, -800.0], false);
query.add_chunk(&region, index, true);
let blocks = query.finish();
```

`read_any` takes any structure format and gives back `Option<Structure>`. Worlds go through `Region`, which holds one region file, and `BoxQuery`, which walks many chunks into a single shared palette. `add_chunk` returns `Read`, `Missing` or `TooOld`, and `counts()` totals them. `Region` also has `chunk` for the raw NBT, `chunk_blocks` for one chunk, and `chunk_extent` for the lowest and highest non-air y.

Blocks come back as `flat`, a `Vec<i32>` of `[state, x, y, z, state, x, y, z, …]`, with `blocks()` for the object form. Finding the region files is left to the caller, so the crate reads no zips. The `wasm` feature is off by default and adds the JavaScript bindings.

## Examples

Two runnable scripts in [`examples/`](examples/):

```bash
npm run structure -- path/to/build.litematic
```

```bash
npm run world -- path/to/world.zip
```

The first summarises any structure file. The second opens a world zip or region file and reports its dimensions, chunks, and a sample chunk's contents.

## License

[MPL-2.0](LICENSE) © [Ewan Howell](https://ewanhowell.com/)
