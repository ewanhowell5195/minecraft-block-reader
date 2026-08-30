use crate::legacy_states::lookup;
use crate::nbt::Compound;
use crate::state::State;
use crate::structure::Block;

const FILTER: &str = "%%FILTER_ME%%";
const SKULL_TYPES: [&str; 6] = ["skeleton", "wither_skeleton", "zombie", "player", "creeper", "dragon"];

pub fn upgrade(palette: &mut Vec<State>, blocks: &mut [Block]) {
    let mut index: std::collections::HashMap<String, i32> = std::collections::HashMap::new();
    for b in blocks.iter_mut() {
        let packed = b.state as u32;
        let id = ((packed & 0xFFF) << 4 | packed >> 12) as u16;
        let entry = lookup(id).or_else(|| lookup(id & !15));

        let (state, key) = match entry {
            Some((_, name, props)) if *name == FILTER => {
                let st = skull_state(props, b.nbt.as_ref());
                let rotation = st
                    .properties
                    .as_ref()
                    .and_then(|p| p.iter().find(|(k, _)| k == "rotation"))
                    .map(|(_, v)| v.clone())
                    .unwrap_or_default();
                let key = format!("{}|{}|{}", b.state, st.id, rotation);
                (st, key)
            }
            Some((_, name, props)) => {
                let st = State {
                    id: (*name).to_string(),
                    properties: if props.is_empty() {
                        None
                    } else {
                        Some(props.iter().map(|(k, v)| ((*k).to_string(), (*v).to_string())).collect())
                    },
                };
                (st, b.state.to_string())
            }
            None => (State { id: "minecraft:air".into(), properties: None }, b.state.to_string()),
        };

        let next = palette.len() as i32;
        b.state = *index.entry(key).or_insert_with(|| {
            palette.push(state);
            next
        });
    }
}

fn skull_state(props: &[(&str, &str)], nbt: Option<&Compound>) -> State {
    let skull_type = nbt
        .and_then(|n| n.get("SkullType"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let mob = SKULL_TYPES.get(skull_type as usize).copied().unwrap_or("skeleton");
    let part = if mob.contains("skeleton") { "skull" } else { "head" };
    let facing = props.iter().find(|(k, _)| *k == "facing").map(|(_, v)| *v);

    if facing == Some("up") || facing == Some("down") {
        let rot = nbt.and_then(|n| n.get("Rot")).and_then(|v| v.as_i64()).unwrap_or(0);
        return State {
            id: format!("minecraft:{mob}_{part}"),
            properties: Some(vec![("rotation".into(), rot.to_string())]),
        };
    }
    State {
        id: format!("minecraft:{mob}_wall_{part}"),
        properties: Some(vec![("facing".into(), facing.unwrap_or("north").to_string())]),
    }
}
