pub mod chunk;
pub mod collector;
pub mod formats;
pub mod legacy;
pub mod legacy_states;
pub mod nbt;
pub mod out;
pub mod region;
pub mod state;
pub mod structure;
pub mod world;

pub use nbt::{read_nbt, Compound, Value};
pub use state::{is_air, is_real_air, norm_state, parse_state, State};
pub use chunk::{chunk_blocks, ChunkBlocks, ChunkOptions};
pub use structure::{Block, Entity, Structure};
pub use world::{BoxQuery, ChunkGrid, ChunkStatus, Counts, Region};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Vanilla,
    Litematic,
    Schem,
    Mcstructure,
    Unknown,
}

/// The key checks are order dependent, matching the js reader.
pub fn kind_of(root: &Compound) -> Kind {
    if root.contains("Regions") {
        return Kind::Litematic;
    }
    if root.contains("Schematic")
        || (root.contains("Palette")
            && (root.contains("BlockData") || root.contains("Data"))
            && root.contains("Width"))
    {
        return Kind::Schem;
    }
    if root
        .get("structure")
        .and_then(|v| v.as_compound())
        .map(|c| c.contains("block_indices"))
        .unwrap_or(false)
    {
        return Kind::Mcstructure;
    }
    if root.contains("blocks")
        && (root.contains("palette") || root.contains("palettes") || root.contains("size"))
    {
        return Kind::Vanilla;
    }
    Kind::Unknown
}

/// Any structure file. Worlds go through `Region` and `BoxQuery`.
pub fn read_any(bytes: &[u8]) -> Option<Structure> {
    if let Ok(root) = read_nbt(bytes, None, &None, &None) {
        match kind_of(&root) {
            Kind::Vanilla => return Some(structure::read_structure(&root)),
            Kind::Litematic => return Some(formats::read_litematic(&root)),
            Kind::Schem => return formats::read_schem(&root),
            Kind::Mcstructure => {}
            Kind::Unknown => {}
        }
    }
    // bedrock files are little endian, so they need the forced pass
    let root = read_nbt(bytes, Some(true), &None, &None).ok()?;
    match kind_of(&root) {
        Kind::Mcstructure => formats::read_mcstructure(&root),
        _ => None,
    }
}

pub fn read_vanilla(bytes: &[u8]) -> Option<Structure> {
    let root = read_nbt(bytes, None, &None, &None).ok()?;
    match kind_of(&root) {
        Kind::Vanilla => Some(structure::read_structure(&root)),
        _ => None,
    }
}

#[cfg(feature = "wasm")]
mod bindings {
    use super::*;
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    pub struct Packed {
        inner: out::Packed,
    }

    #[wasm_bindgen]
    impl Packed {
        #[wasm_bindgen(getter)]
        pub fn size(&self) -> Vec<i32> {
            self.inner.size.clone()
        }
        #[wasm_bindgen(getter)]
        pub fn palette(&self) -> String {
            self.inner.palette.clone()
        }
        #[wasm_bindgen(getter)]
        pub fn blocks(&self) -> Vec<i32> {
            self.inner.blocks.clone()
        }
        /// nbt bytes: `bi` block indices, `bn` their nbt, `ep` entity
        /// positions, `en` entity nbt
        #[wasm_bindgen(getter)]
        pub fn extras(&self) -> Vec<u8> {
            self.inner.extras.clone()
        }
        /// 0 read, 1 missing, 2 too old to read
        #[wasm_bindgen(getter)]
        pub fn status(&self) -> u8 {
            self.inner.status
        }
    }

    #[wasm_bindgen(js_name = readStructure)]
    pub fn read_structure_js(bytes: &[u8]) -> Option<Packed> {
        read_any(bytes).map(|s| Packed { inner: out::pack(&s) })
    }

    #[wasm_bindgen(js_name = Region)]
    pub struct RegionJs {
        inner: Region,
    }

    #[wasm_bindgen(js_class = Region)]
    impl RegionJs {
        #[wasm_bindgen(constructor)]
        pub fn new(bytes: Vec<u8>) -> RegionJs {
            RegionJs { inner: Region::new(bytes) }
        }

        #[wasm_bindgen(js_name = chunkGrid)]
        pub fn chunk_grid(&self, index: usize, y_min: i32, y_max: i32) -> Option<PackedGridJs> {
            let g = self.inner.chunk_grid(index, y_min, y_max)?;
            let mut pos = Vec::with_capacity(g.block_entities.len() * 3);
            let mut nbt = Vec::with_capacity(g.block_entities.len());
            for (p, c) in &g.block_entities {
                pos.extend_from_slice(p);
                nbt.push(Value::Compound(c.clone()));
            }
            let mut extras = Compound::default();
            extras.insert("bp", Value::IntArray(pos));
            extras.insert("bn", Value::List(nbt::COMPOUND, nbt));
            let s = Structure { size: [0, 0, 0], palette: g.palette, blocks: Vec::new(), entities: Vec::new() };
            Some(PackedGridJs {
                palette: out::palette_json(&s),
                grid: g.grid,
                extras: nbt::Writer::new().root(&extras),
                empty: g.empty,
            })
        }

        /// `[bottom, top]` of the non air blocks, or nothing when the chunk is empty.
        #[wasm_bindgen(js_name = chunkExtent)]
        pub fn chunk_extent(&self, index: usize) -> Option<Vec<i32>> {
            self.inner.chunk_extent(index).map(|(bottom, top)| vec![bottom, top])
        }
    }

    /// A chunk as a dense voxel grid: `grid` is `256 * height` cells of
    /// `(y - yMin) * 256 + z * 16 + x`, 0 for air or a one based palette index.
    #[wasm_bindgen(js_name = PackedGrid)]
    pub struct PackedGridJs {
        palette: String,
        grid: Vec<u16>,
        extras: Vec<u8>,
        empty: bool,
    }

    #[wasm_bindgen(js_class = PackedGrid)]
    impl PackedGridJs {
        #[wasm_bindgen(getter)]
        pub fn palette(&self) -> String {
            self.palette.clone()
        }
        #[wasm_bindgen(getter)]
        pub fn grid(&self) -> Vec<u16> {
            self.grid.clone()
        }
        /// nbt bytes: `bp` block entity positions, `bn` their nbt
        #[wasm_bindgen(getter)]
        pub fn extras(&self) -> Vec<u8> {
            self.extras.clone()
        }
        #[wasm_bindgen(getter)]
        pub fn empty(&self) -> bool {
            self.empty
        }
    }

    #[wasm_bindgen(js_name = BoxQuery)]
    pub struct BoxQueryJs {
        inner: BoxQuery,
    }

    #[wasm_bindgen(js_class = BoxQuery)]
    impl BoxQueryJs {
        #[wasm_bindgen(constructor)]
        pub fn new(
            x0: f64,
            y0: f64,
            z0: f64,
            x1: f64,
            y1: f64,
            z1: f64,
            include_air: bool,
        ) -> BoxQueryJs {
            BoxQueryJs { inner: BoxQuery::new([x0, y0, z0], [x1, y1, z1], include_air) }
        }

        /// 0 read, 1 missing, 2 too old
        #[wasm_bindgen(js_name = addChunk)]
        pub fn add_chunk(&mut self, region: &RegionJs, index: usize, with_entities: bool) -> u8 {
            match self.inner.add_chunk(&region.inner, index, with_entities) {
                ChunkStatus::Read => 0,
                ChunkStatus::Missing => 1,
                ChunkStatus::TooOld => 2,
            }
        }

        #[wasm_bindgen(js_name = addEntities)]
        pub fn add_entities(&mut self, region: &RegionJs, index: usize) {
            self.inner.add_entities(&region.inner, index)
        }

        #[wasm_bindgen(getter)]
        pub fn counts(&self) -> Vec<u32> {
            let c = self.inner.counts();
            vec![c.read, c.missing, c.outdated]
        }

        pub fn finish(&mut self) -> Packed {
            Packed { inner: out::pack_chunk(&self.inner.finish()) }
        }
    }
}
