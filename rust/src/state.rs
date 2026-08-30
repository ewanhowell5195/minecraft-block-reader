use crate::nbt::{Compound, Value};

#[derive(Debug, Clone, PartialEq, Default)]
pub struct State {
    pub id: String,
    pub properties: Option<Vec<(String, String)>>,
}

/// `[\w./-]`
fn id_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '/' || c == '-'
}

/// `(^|:)(air|cave_air|void_air|structure_void)$`
pub fn is_air(id: &str) -> bool {
    matches_tail(id, &["air", "cave_air", "void_air", "structure_void"])
}

/// `(^|:)(air|cave_air|void_air)$`
pub fn is_real_air(id: &str) -> bool {
    matches_tail(id, &["air", "cave_air", "void_air"])
}

fn matches_tail(id: &str, names: &[&str]) -> bool {
    for name in names {
        if id == *name {
            return true;
        }
        if let Some(rest) = id.strip_suffix(name) {
            if rest.ends_with(':') {
                return true;
            }
        }
    }
    false
}

/// The `id[a=b,c=d]` form used in commands, schem palettes and datapacks.
/// Anything unparseable reads as air, matching the js reader.
pub fn parse_state(str: &str) -> State {
    let s = str.trim();
    let air = State { id: "minecraft:air".into(), properties: None };

    let (head, props) = match s.find('[') {
        Some(i) => {
            if !s.ends_with(']') {
                return air;
            }
            (&s[..i], Some(&s[i + 1..s.len() - 1]))
        }
        None => (s, None),
    };

    if !valid_id(head) {
        return air;
    }
    let id = if head.contains(':') { head.to_string() } else { format!("minecraft:{head}") };

    let Some(body) = props else {
        return State { id, properties: None };
    };
    if body.is_empty() {
        return State { id, properties: Some(Vec::new()) };
    }
    let mut properties = Vec::new();
    for kv in body.split(',') {
        let mut it = kv.splitn(2, '=');
        let k = it.next().unwrap_or("");
        if let Some(v) = it.next() {
            if !k.is_empty() {
                properties.push((k.trim().to_string(), v.trim().to_string()));
            }
        }
    }
    State { id, properties: Some(properties) }
}

/// `^[\w./-]+(?::[\w./-]+)?$`
fn valid_id(head: &str) -> bool {
    if head.is_empty() {
        return false;
    }
    let mut parts = head.split(':');
    let first = parts.next().unwrap_or("");
    if first.is_empty() || !first.chars().all(id_char) {
        return false;
    }
    match parts.next() {
        None => true,
        Some(second) => {
            parts.next().is_none() && !second.is_empty() && second.chars().all(id_char)
        }
    }
}

/// `^[\w./-]+(?::[\w./-]+)?(?:\[.*\])?$`
fn looks_like_state(s: &str) -> bool {
    let s = s.trim();
    match s.find('[') {
        Some(i) => s.ends_with(']') && valid_id(&s[..i]),
        None => valid_id(s),
    }
}

/// 26.3-snapshot-7 renamed `Name` to `id` and `Properties` to `properties`, and
/// writes a default state as the bare block id. Older files fold forward.
/// Values that are not block states come back as None so callers can pass them
/// through untouched.
pub fn norm_state(v: &Value) -> Option<State> {
    match v {
        Value::Str(s) => {
            if looks_like_state(s) {
                Some(parse_state(s))
            } else {
                None
            }
        }
        Value::Compound(c) => {
            if let Some(Value::Str(name)) = c.get("Name") {
                let properties = match c.get("Properties") {
                    Some(Value::Compound(p)) => Some(props_of(p)),
                    _ => None,
                };
                return Some(State { id: name.clone(), properties });
            }
            if let Some(Value::Str(id)) = c.get("id") {
                let properties = match c.get("properties") {
                    Some(Value::Compound(p)) => Some(props_of(p)),
                    _ => None,
                };
                return Some(State { id: id.clone(), properties });
            }
            None
        }
        _ => None,
    }
}

fn props_of(c: &Compound) -> Vec<(String, String)> {
    c.entries
        .iter()
        .map(|(k, v)| {
            let s = match v {
                Value::Str(s) => s.clone(),
                Value::Byte(x) => x.to_string(),
                Value::Short(x) => x.to_string(),
                Value::Int(x) => x.to_string(),
                Value::Long(x) => x.to_string(),
                other => format!("{other:?}"),
            };
            (k.clone(), s)
        })
        .collect()
}

impl State {
    /// Stable key for palette deduplication, matching the js reader's
    /// `id + "|" + JSON.stringify(properties ?? null)`.
    pub fn key(&self) -> String {
        let mut k = String::with_capacity(self.id.len() + 16);
        k.push_str(&self.id);
        k.push('|');
        match &self.properties {
            None => k.push_str("null"),
            Some(p) => {
                k.push('{');
                for (i, (a, b)) in p.iter().enumerate() {
                    if i > 0 {
                        k.push(',');
                    }
                    k.push_str(a);
                    k.push('=');
                    k.push_str(b);
                }
                k.push('}');
            }
        }
        k
    }
}
