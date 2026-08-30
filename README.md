# minecraft-block-reader

Read blocks, block states, and entities from Minecraft structure files and world saves.
Works in Node.js and the browser, with no dependencies.

[![npm version](https://badge.fury.io/js/minecraft-block-reader.svg)](https://www.npmjs.com/package/minecraft-block-reader)
[![jsDelivr](https://data.jsdelivr.com/v1/package/npm/minecraft-block-reader/badge)](https://www.jsdelivr.com/package/npm/minecraft-block-reader)
[![License: MPL 2.0](https://img.shields.io/badge/License-MPL_2.0-brightgreen.svg)](https://opensource.org/licenses/MPL-2.0)

## Features

* Reads structure files: `.nbt`, `.litematic`, `.schem`, and `.mcstructure`
* Reads world saves: a world folder as a `.zip`, or a single `.mca` region file
* One `read` function that works out what it was given, and one output shape for every format
* Block entities attached to their blocks, entities alongside
* Lazy world reading: pass a `Blob` and only the pieces being read are pulled off disk, so multi-GB worlds never load whole

## Install

For Node.js, or the browser through a bundler:

```bash
npm install minecraft-block-reader
```

Or in the browser, import it straight from a [CDN](https://www.jsdelivr.com/package/npm/minecraft-block-reader):

```js
import { read } from "https://cdn.jsdelivr.net/npm/minecraft-block-reader/+esm"
```

With Vite's dev server, for example, the dependency pre-bundler moves the module URL without copying the WebAssembly module alongside it, so it quietly fails to load and the reader falls back to its slower JavaScript path. Exclude the library from pre-bundling:

```js
// vite.config.js
export default defineConfig({
  optimizeDeps: {
    exclude: ["minecraft-block-reader"]
  }
})
```

Vite builds are unaffected, since Rollup resolves the URL itself and emits the module as an asset. Reading inside a web worker also wants `worker: { format: "es" }`, since the JavaScript fallback is pulled in with a dynamic import and Vite's default `iife` worker format cannot code-split. Other bundlers may need their own equivalent.

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

Every result also carries `raw`, the same blocks as one flat `Int32Array` of `[state, x, y, z, state, x, y, z, …]`, and `blocks` is built from it only if something reads it. For millions of blocks the objects cost far more than the parse does, so a consumer that can work in numbers should stay on `raw`:

```js
const { palette, raw } = await world.blocks(box)
for (let i = 0; i < raw.length; i += 4) {
  const state = palette[raw[i]], x = raw[i + 1], y = raw[i + 2], z = raw[i + 3]
}
```

Block entities come with `blockNbt`, a `Map` from a block's index in `raw` to its nbt, so `raw` never has to fall back to the objects to reach them.

## Documentation

The full export list:

| Export | |
|---|---|
| [`read(src, options)`](#readsrc-options) | Parse anything: structure files to structures, saves to world handles |
| [`chunkBlocks(nbt, options)`](#worlds) | Unpack one chunk's NBT into palette + blocks + entities |
| [`readNBT(bytes, options)`](#nbt) | The NBT parser on its own |
| [`parseState(str)`](#block-states) | A block state string as `{ id, properties }` |
| [`normState(v)`](#block-states) | Any older state shape folded to the current one |
| [`AIR`, `REAL_AIR`](#block-states) | Regexes matching air ids |

### read(src, options)

`src` is the file: a `Buffer`, `Uint8Array`, `ArrayBuffer`, or `Blob`. Blobs (a browser `File`, or `fs.openAsBlob(path)` in node) are read lazily for worlds: only the pieces being read are pulled off disk, so multi-GB worlds never load whole.

All options are optional:

| Option | Description |
|---|---|
| `region` | A lone region file's coordinates as `[x, z]` (the `r.x.z.mca` numbers), defaulting to `[0, 0]` |
| `dimension` | Worlds: the dimension to open on, instead of the overworld |
| `onProgress` | Worlds: called with `(done, total)` while the regions are scanned |

The format is detected from the bytes: every format carries a signature nothing else can. Gzip is handled everywhere, all formats carry their block entities and entities, and Bedrock state mapping is best-effort.

`size` is the occupied bounds: litematic, schem, and mcstructure files are trimmed to the blocks they actually contain, while vanilla `.nbt` files keep their declared size.

Vanilla `.nbt` files from any version read, including the palette-less 1.9-era format, whose packed numeric states come back as the block states the vanilla flattening maps them to.

### Worlds

Opening a world scans it without loading it; everything block-level happens on demand through the handle `read` returns. Chunks from 1.13 on are readable, with pre-1.18 shapes folded to the current one; pre-1.13 chunks are reported rather than read:

| API | Description |
|---|---|
| `world.name` | The level name |
| `world.blocks(box, onProgress?)` | The blocks in a block-coordinate box (`{ x0, y0, z0, x1, y1, z1, includeAir }`, inclusive on every side, y bounds optional): one shared palette, the box's entities, block entity nbt attached. Ungenerated and pre-1.13 chunks aren't errors; the result's `chunks: { read, missing, outdated }` says what the box covered, so an empty result can tell "air" from "unexplored" from "too old" |
| `world.chunks` | Every stored chunk, as `{ cx, cz, region, index }` |
| `world.chunk(c)` | A chunk's NBT, with its entities folded in under `Entities` (the game stores them in separate region files) |
| `world.chunkExtent(c, { yMin, yMax })` | The chunk's occupied `{ top, bottom }`, from the palettes alone. The y bounds are optional and judge a section by whether it overlaps them |
| `world.chunkBlocks(c, { yMin, yMax, includeAir })` | One chunk's blocks, for walking a selection a chunk at a time instead of asking for a whole box. Null for a chunk that is missing or too old |
| `world.chunkGrid(c, { yMin, yMax })` | The chunk as a dense voxel grid, for renderers that want O(1) neighbour lookups: `grid` is a `Uint16Array` of `256 * height` cells indexed `(y - yMin) * 256 + z * 16 + x`, holding 0 for air or a one-based index into `palette`, plus `beList` and an `empty` flag |
| `world.dimension` | The current dimension id |
| `world.dimensions` | The dimension ids, e.g. `["overworld", "the_nether"]` |
| `world.setDimension(id, onProgress?)` | Switches the world to another of its dimensions |
| `world.structures` | The world's `generated/` structure files, as names |
| `world.structure(rel)` | One of those, read as a structure |
| `world.file(path)` | Any other file from the save (`level.dat`, map items, datapacks), as bytes |

`chunkBlocks` is also exported for chunk-by-chunk work like streaming, where `world.blocks` would hold too much at once. It unpacks one chunk's NBT into palette + blocks + entities with world-space positions, with `yMin`, `yMax`, and `includeAir` options:

```js
import { chunkBlocks } from "minecraft-block-reader"

for (const c of world.chunks) {
  const { palette, blocks, entities } = chunkBlocks(await world.chunk(c), { yMin: 0, yMax: 128 })
}
```

### NBT

```js
import { readNBT } from "minecraft-block-reader"

const root = await readNBT(bytes)
```

Java (big-endian) and Bedrock (little-endian) NBT, with the endianness worked out from the bytes and gzip unpacked on the way in. Longs come back as `BigInt`, long arrays as `Uint32Array` `[lo, hi]` pairs.

| Option | Description |
|---|---|
| `only` | Keep just these root keys |
| `skip` | Drop these keys, at any depth |
| `littleEndian` | Force the endianness instead of detecting it |

Detection is decided by parsing rather than guessing: a byte-swapped read hits an invalid tag type or runs off the end within a few hundred bytes, and the endianness that consumes the whole buffer wins. Pass `littleEndian` when you already know, and the other attempt is never made.

#### Reading part of a file

`only` and `skip` leave out values you are never going to look at. The bytes are still walked, since NBT has no index and the parser has to step over a value to find the next one, but nothing is decoded or allocated for them.

Both take a name, a list of names, or a `Set`:

```js
{ only: "sections" }
{ only: ["sections", "block_entities"] }
{ skip: new Set(["block_light", "sky_light"]) }
```

They filter at different depths, which is what makes them worth having separately:

**`only` applies to the root**, so it says what the file is being read *for*. Everything under a key it keeps is decoded in full:

```js
await readNBT(chunk, { only: ["sections", "xPos", "zPos"] })
// { sections: [ … ], xPos: -22, zPos: -29 }   whole sections, nothing else
```

**`skip` applies at every depth**, matching on name rather than path, so it reaches things nested far inside and drops them wherever they appear:

```js
await readNBT(bytes, { skip: "Heightmaps" })
// { keep: 1, deep: { keep2: 2 } }   the nested Heightmaps went too
```

That reach is the point for data buried in a structure you otherwise want, and the reason to be careful with a name the format reuses, `data` being the obvious one. The two combine, `only` choosing the branches and `skip` pruning within them, which is exactly how this library reads a chunk: `only` for the handful of root fields it needs, `skip` for the light arrays that live inside the sections.

Use them when a file is large or there are thousands of it. On a 19KB world chunk, dropping the lighting, biome and heightmap data takes a parse from 0.22ms to 0.15ms, around a third; for a single small file it is not worth the thought. Passing a `Set` avoids rebuilding one per call, which only matters in that thousands case.

### Block states

The helpers the readers use to produce the `{ id, properties }` shape, exported because they are just as useful outside.

`parseState` turns a block state string, the form used in commands, `.schem` palettes and datapacks, into that shape. An id with no namespace gets `minecraft:`, properties are always strings, and the key is left off entirely when there are none:

```js
parseState("oak_stairs[facing=north]")  // { id: "minecraft:oak_stairs", properties: { facing: "north" } }
parseState("minecraft:stone")           // { id: "minecraft:stone" }
parseState("garbage!!")                 // { id: "minecraft:air" }   anything unparseable reads as air
```

`normState` takes a state in any form Minecraft has used and returns the current one, which is how files written before 26.3 are folded forward. Values that aren't block states come back untouched, so it is safe to map over mixed data:

```js
normState({ Name: "minecraft:chest", Properties: { facing: "north" } })
// { id: "minecraft:chest", properties: { facing: "north" } }

normState("minecraft:stone")        // { id: "minecraft:stone" }
normState({ id: "minecraft:stone" }) // unchanged
normState(42)                        // 42
```

`AIR` and `REAL_AIR` are regexes for testing whether an id is air. Both match with or without the namespace, so `AIR.test("air")` and `AIR.test("minecraft:air")` are alike:

| | Matches |
|---|---|
| `AIR` | `air`, `cave_air`, `void_air`, `structure_void` |
| `REAL_AIR` | `air`, `cave_air`, `void_air` |

The difference is `structure_void`, which means "leave whatever is already here" and only exists in structure files. Use `AIR` when reading a structure, where it should be skipped like air, and `REAL_AIR` for world data, where a genuine block is never structure void.

## Rust

The parsing is a Rust crate, which the WebAssembly module is built from. It works on its own, without the JavaScript layer:

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

`read_any` takes any structure format and gives back `Option<Structure>`. Worlds go through `Region`, one region file held so a browse never copies it per chunk, and `BoxQuery`, which walks many chunks into a single shared palette. `add_chunk` returns `Read`, `Missing` or `TooOld`, and `counts()` totals them, so an empty result can say why it is empty. `Region` also has `chunk` for the raw NBT, `chunk_blocks` for one chunk, and `chunk_extent` for the lowest and highest non-air y.

Blocks come back as `flat`, a `Vec<i32>` of `[state, x, y, z, state, x, y, z, …]`, with `blocks()` for the object form. Finding the region files is left to the caller, so the crate reads no zips. The `wasm` feature is off by default and only adds the JavaScript bindings.

## Examples

Two runnable scripts in [`examples/`](examples/):

```bash
npm run structure -- path/to/build.litematic
```

```bash
npm run world -- path/to/world.zip
```

The first summarises any structure file: size, palette, a top-blocks tally, block entities, and entities. The second opens a world zip or region file and reports its dimensions, chunks, and a sample chunk's contents.

## License

[MPL-2.0](LICENSE) © [Ewan Howell](https://ewanhowell.com/)
