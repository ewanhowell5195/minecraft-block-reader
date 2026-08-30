use crate::nbt::{Compound, Value};
use crate::state::{norm_state, State};

#[derive(Debug, Clone, Default)]
pub struct Block {
    pub state: i32,
    pub pos: [i32; 3],
    pub nbt: Option<Compound>,
}

#[derive(Debug, Clone)]
pub struct Entity {
    pub pos: [f64; 3],
    pub nbt: Compound,
}

#[derive(Debug, Clone, Default)]
pub struct Structure {
    pub size: [i32; 3],
    pub palette: Vec<State>,
    pub blocks: Vec<Block>,
    pub entities: Vec<Entity>,
}

fn nums3(v: Option<&Value>) -> [f64; 3] {
    let mut out = [0.0; 3];
    if let Some(Value::List(_, items)) = v {
        for (i, it) in items.iter().take(3).enumerate() {
            out[i] = it.as_f64().unwrap_or(0.0);
        }
    } else if let Some(Value::IntArray(a)) = v {
        for (i, x) in a.iter().take(3).enumerate() {
            out[i] = *x as f64;
        }
    }
    out
}

fn ints3(v: Option<&Value>) -> [i32; 3] {
    let f = nums3(v);
    [f[0] as i32, f[1] as i32, f[2] as i32]
}

/// Vanilla `.nbt`. Some files (shipwrecks) use the plural `palettes` form.
pub fn read_structure(root: &Compound) -> Structure {
    let size = ints3(root.get("size"));

    let palette_items = match root.get("palette") {
        Some(Value::List(_, items)) => Some(items),
        _ => match root.get("palettes") {
            Some(Value::List(_, sets)) => sets.first().and_then(|f| f.as_list()),
            _ => None,
        },
    };
    let mut palette = palette_items
        .map(|items| {
            items
                .iter()
                .map(|v| norm_state(v).unwrap_or_default())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let mut blocks = Vec::new();
    if let Some(Value::List(_, items)) = root.get("blocks") {
        blocks.reserve(items.len());
        for it in items {
            let Some(c) = it.as_compound() else { continue };
            blocks.push(Block {
                state: c.get("state").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
                pos: ints3(c.get("pos")),
                nbt: c.get("nbt").and_then(|v| v.as_compound()).cloned(),
            });
        }
    }

    if palette.is_empty() && !blocks.is_empty() {
        crate::legacy::upgrade(&mut palette, &mut blocks);
    }

    // only entities carrying nbt survive, and `pos` wins over `blockPos`
    let mut entities = Vec::new();
    if let Some(Value::List(_, items)) = root.get("entities") {
        for it in items {
            let Some(c) = it.as_compound() else { continue };
            let Some(nbt) = c.get("nbt").and_then(|v| v.as_compound()) else { continue };
            let pos = if c.contains("pos") {
                nums3(c.get("pos"))
            } else {
                nums3(c.get("blockPos"))
            };
            entities.push(Entity { pos, nbt: nbt.clone() });
        }
    }

    Structure { size, palette, blocks, entities }
}
