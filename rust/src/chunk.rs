use std::collections::HashMap;

use crate::collector::words;
use crate::nbt::{Compound, Value};
use crate::state::{is_real_air, norm_state, State};
use crate::structure::{Block, Entity};

pub struct ChunkOptions {
    pub y_min: f64,
    pub y_max: f64,
    pub include_air: bool,
    pub x_min: f64,
    pub x_max: f64,
    pub z_min: f64,
    pub z_max: f64,
    /// A 1.17+ world keeps entities in their own region file, so a caller that
    /// has one wants the chunk's own entity list ignored.
    pub entities: bool,
}

impl Default for ChunkOptions {
    fn default() -> Self {
        ChunkOptions {
            y_min: f64::NEG_INFINITY,
            y_max: f64::INFINITY,
            include_air: false,
            x_min: f64::NEG_INFINITY,
            x_max: f64::INFINITY,
            z_min: f64::NEG_INFINITY,
            z_max: f64::INFINITY,
            entities: true,
        }
    }
}

#[derive(Default)]
pub struct Acc {
    pub palette: Vec<State>,
    pub index: HashMap<String, usize>,
    pub flat: Vec<i32>,
    pub block_nbt: Vec<(u32, Compound)>,
    pub entities: Vec<Entity>,
}

/// Blocks come out as a flat `[state, x, y, z, state, x, y, z, ...]` run.
#[derive(Default)]
pub struct ChunkBlocks {
    pub palette: Vec<State>,
    pub flat: Vec<i32>,
    pub block_nbt: Vec<(u32, Compound)>,
    pub entities: Vec<Entity>,
}

impl ChunkBlocks {
    pub fn count(&self) -> usize {
        self.flat.len() / 4
    }
    pub fn blocks(&self) -> Vec<Block> {
        let mut out: Vec<Block> = self
            .flat
            .chunks_exact(4)
            .map(|c| Block { state: c[0], pos: [c[1], c[2], c[3]], nbt: None })
            .collect();
        for (i, n) in &self.block_nbt {
            out[*i as usize].nbt = Some(n.clone());
        }
        out
    }
}

pub fn chunk_blocks(nbt: &Compound, opts: &ChunkOptions) -> ChunkBlocks {
    let mut acc = Acc::default();
    chunk_into(nbt, opts, &mut acc);
    ChunkBlocks {
        palette: acc.palette,
        flat: acc.flat,
        block_nbt: acc.block_nbt,
        entities: acc.entities,
    }
}

pub fn chunk_into(nbt: &Compound, opts: &ChunkOptions, acc: &mut Acc) {
    let Acc { palette, index, flat, block_nbt, entities } = acc;
    let state_for = |e: &State, palette: &mut Vec<State>, index: &mut HashMap<String, usize>| -> i32 {
        let key = e.key();
        if let Some(i) = index.get(&key) {
            return *i as i32;
        }
        let i = palette.len();
        palette.push(e.clone());
        index.insert(key, i);
        i as i32
    };

    // block entities are keyed by their absolute position
    let mut be_map: HashMap<(i32, i32, i32), Compound> = HashMap::new();
    if let Some(Value::List(_, items)) = nbt.get("block_entities") {
        for it in items {
            let Some(c) = it.as_compound() else { continue };
            let (Some(x), Some(y), Some(z)) = (
                c.get("x").and_then(int_only),
                c.get("y").and_then(int_only),
                c.get("z").and_then(int_only),
            ) else {
                continue;
            };
            let mut rest = Compound::default();
            for (k, v) in &c.entries {
                if k != "x" && k != "y" && k != "z" && k != "keepPacked" {
                    rest.entries.push((k.clone(), v.clone()));
                }
            }
            be_map.insert((x, y, z), rest);
        }
    }

    let cx = nbt.get("xPos").and_then(|v| v.as_i64()).unwrap_or(0) as i32 * 16;
    let cz = nbt.get("zPos").and_then(|v| v.as_i64()).unwrap_or(0) as i32 * 16;
    let has_be = !be_map.is_empty();
    let data_version = nbt.get("DataVersion").and_then(|v| v.as_i64()).unwrap_or(0);

    if let Some(Value::List(_, sections)) = nbt.get("sections") {
        for s in sections {
            let Some(sc) = s.as_compound() else { continue };
            let Some(bs) = sc.get("block_states").and_then(|v| v.as_compound()) else { continue };
            let Some(Value::List(_, pal)) = bs.get("palette") else { continue };

            let sy = sc.get("Y").and_then(|v| v.as_i64()).unwrap_or(0) as i32 * 16;
            if (sy as f64) > opts.y_max || ((sy + 15) as f64) < opts.y_min {
                continue;
            }

            let map: Vec<i32> = pal
                .iter()
                .map(|e| {
                    let st = norm_state(e).unwrap_or_default();
                    if !opts.include_air && is_real_air(&st.id) {
                        -1
                    } else {
                        state_for(&st, palette, index)
                    }
                })
                .collect();

            let put = |i: usize, st: i32, flat: &mut Vec<i32>, block_nbt: &mut Vec<(u32, Compound)>| {
                let y = sy + (i >> 8) as i32;
                if (y as f64) < opts.y_min || (y as f64) > opts.y_max {
                    return;
                }
                let x = cx + (i & 15) as i32;
                let z = cz + ((i >> 4) & 15) as i32;
                if (x as f64) < opts.x_min
                    || (x as f64) > opts.x_max
                    || (z as f64) < opts.z_min
                    || (z as f64) > opts.z_max
                {
                    return;
                }
                if has_be {
                    if let Some(n) = be_map.get(&(x, y, z)) {
                        block_nbt.push(((flat.len() / 4) as u32, n.clone()));
                    }
                }
                flat.extend_from_slice(&[st, x, y, z]);
            };

            if pal.len() == 1 {
                if map[0] == -1 {
                    continue;
                }
                for i in 0..4096 {
                    put(i, map[0], flat, block_nbt);
                }
                continue;
            }

            let data: Vec<u32> = match bs.get("data") {
                Some(Value::LongArray(a)) => words(a),
                _ => Vec::new(),
            };
            let bits = (32 - ((pal.len() - 1) as u32).leading_zeros()).max(4);
            let mask: u32 = if bits >= 32 { u32::MAX } else { (1u32 << bits) - 1 };

            // pre 1.16 packed indices span long boundaries
            if data_version < 2527 {
                let mut w = 0usize;
                let mut off = 0u32;
                for i in 0..4096 {
                    let mut v = data.get(w).copied().unwrap_or(0) >> off;
                    if off + bits > 32 {
                        v |= data.get(w + 1).copied().unwrap_or(0) << (32 - off);
                    }
                    off += bits;
                    if off >= 32 {
                        w += (off >> 5) as usize;
                        off &= 31;
                    }
                    let idx = (v & mask) as usize;
                    if let Some(&st) = map.get(idx) {
                        if st != -1 {
                            put(i, st, flat, block_nbt);
                        }
                    }
                }
                continue;
            }

            let vpl = 64 / bits;
            let longs = data.len() / 2;
            let mut i = 0usize;
            for li in 0..longs {
                if i >= 4096 {
                    break;
                }
                let lo = data[li * 2];
                let hi = data[li * 2 + 1];
                for j in 0..vpl {
                    if i >= 4096 {
                        break;
                    }
                    let off = j * bits;
                    let v = if off + bits <= 32 {
                        (lo >> off) & mask
                    } else if off >= 32 {
                        (hi >> (off - 32)) & mask
                    } else {
                        ((lo >> off) | (hi << (32 - off))) & mask
                    };
                    if let Some(&st) = map.get(v as usize) {
                        if st != -1 {
                            put(i, st, flat, block_nbt);
                        }
                    }
                    i += 1;
                }
            }
        }
    }

    if !opts.entities {
        return;
    }
    if let Some(Value::List(_, items)) = nbt.get("Entities") {
        for e in items {
            let Some(c) = e.as_compound() else { continue };
            let Some(Value::List(_, p)) = c.get("Pos") else { continue };
            if p.len() < 3 {
                continue;
            }
            let pos = [
                p[0].as_f64().unwrap_or(0.0),
                p[1].as_f64().unwrap_or(0.0),
                p[2].as_f64().unwrap_or(0.0),
            ];
            if pos[1] < opts.y_min || pos[1] > opts.y_max + 1.0 {
                continue;
            }
            // the js reader lets entities sit one block past the box edge
            if pos[0] < opts.x_min
                || pos[0] > opts.x_max + 1.0
                || pos[2] < opts.z_min
                || pos[2] > opts.z_max + 1.0
            {
                continue;
            }
            entities.push(Entity { pos, nbt: c.clone() });
        }
    }
}

/// `typeof be?.x !== "number"` in the js reader: any numeric tag counts.
fn int_only(v: &Value) -> Option<i32> {
    v.as_i64().map(|x| x as i32)
}
