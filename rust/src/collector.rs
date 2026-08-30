use std::collections::HashMap;

use crate::nbt::Compound;
use crate::state::State;
use crate::structure::{Block, Entity, Structure};

pub struct Collector {
    palette: Vec<State>,
    index: HashMap<String, usize>,
    cells: Vec<(i32, i32, i32, i32)>,
    nbts: HashMap<(i32, i32, i32), Compound>,
    ents: Vec<(f64, f64, f64, Compound)>,
}

impl Collector {
    pub fn new() -> Self {
        Collector {
            palette: Vec::new(),
            index: HashMap::new(),
            cells: Vec::new(),
            nbts: HashMap::new(),
            ents: Vec::new(),
        }
    }

    pub fn state_for(&mut self, id: &str, properties: Option<Vec<(String, String)>>) -> i32 {
        let state = State { id: id.to_string(), properties };
        let key = state.key();
        if let Some(i) = self.index.get(&key) {
            return *i as i32;
        }
        let i = self.palette.len();
        self.palette.push(state);
        self.index.insert(key, i);
        i as i32
    }

    pub fn push(&mut self, x: i32, y: i32, z: i32, state: i32) {
        self.cells.push((x, y, z, state));
    }

    pub fn block_nbt(&mut self, x: i32, y: i32, z: i32, nbt: Compound) {
        self.nbts.insert((x, y, z), nbt);
    }

    pub fn entity(&mut self, pos: [f64; 3], nbt: Compound) {
        self.ents.push((pos[0], pos[1], pos[2], nbt));
    }

    pub fn finish(self) -> Structure {
        if self.cells.is_empty() {
            return Structure {
                size: [1, 1, 1],
                palette: vec![State { id: "minecraft:air".into(), properties: None }],
                blocks: vec![Block { state: 0, pos: [0, 0, 0], nbt: None }],
                entities: self
                    .ents
                    .into_iter()
                    .map(|(x, y, z, nbt)| Entity { pos: [x, y, z], nbt })
                    .collect(),
            };
        }

        let mut lo = [i32::MAX; 3];
        let mut hi = [i32::MIN; 3];
        for c in &self.cells {
            let p = [c.0, c.1, c.2];
            for i in 0..3 {
                lo[i] = lo[i].min(p[i]);
                hi[i] = hi[i].max(p[i]);
            }
        }

        let blocks = self
            .cells
            .iter()
            .map(|c| Block {
                state: c.3,
                pos: [c.0 - lo[0], c.1 - lo[1], c.2 - lo[2]],
                nbt: self.nbts.get(&(c.0, c.1, c.2)).cloned(),
            })
            .collect();

        let entities = self
            .ents
            .into_iter()
            .map(|(x, y, z, nbt)| Entity {
                pos: [x - lo[0] as f64, y - lo[1] as f64, z - lo[2] as f64],
                nbt,
            })
            .collect();

        Structure {
            size: [hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1],
            palette: self.palette,
            blocks,
            entities,
        }
    }
}

/// The js reader stores long arrays as `[lo, hi]` u32 pairs so packed indices
/// never touch bigint; the unpackers here read the same layout.
pub fn words(longs: &[i64]) -> Vec<u32> {
    let mut out = Vec::with_capacity(longs.len() * 2);
    for l in longs {
        out.push(*l as u32);
        out.push((*l >> 32) as u32);
    }
    out
}
