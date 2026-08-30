use std::collections::BTreeMap;
use zune_inflate::{DeflateDecoder, DeflateOptions};

pub const END: u8 = 0;
pub const BYTE: u8 = 1;
pub const SHORT: u8 = 2;
pub const INT: u8 = 3;
pub const LONG: u8 = 4;
pub const FLOAT: u8 = 5;
pub const DOUBLE: u8 = 6;
pub const BYTE_ARRAY: u8 = 7;
pub const STRING: u8 = 8;
pub const LIST: u8 = 9;
pub const COMPOUND: u8 = 10;
pub const INT_ARRAY: u8 = 11;
pub const LONG_ARRAY: u8 = 12;

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Byte(i8),
    Short(i16),
    Int(i32),
    Long(i64),
    Float(f32),
    Double(f64),
    ByteArray(Vec<u8>),
    Str(String),
    List(u8, Vec<Value>),
    Compound(Compound),
    IntArray(Vec<i32>),
    LongArray(Vec<i64>),
}

/// Insertion order matters for round tripping, so entries are a vec with a
/// lookup built only when a compound is large.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Compound {
    pub entries: Vec<(String, Value)>,
}

impl Compound {
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
    pub fn contains(&self, key: &str) -> bool {
        self.get(key).is_some()
    }
    pub fn insert(&mut self, key: impl Into<String>, value: Value) {
        self.entries.push((key.into(), value));
    }
}

impl Value {
    pub fn as_i64(&self) -> Option<i64> {
        Some(match self {
            Value::Byte(v) => *v as i64,
            Value::Short(v) => *v as i64,
            Value::Int(v) => *v as i64,
            Value::Long(v) => *v,
            Value::Float(v) => *v as i64,
            Value::Double(v) => *v as i64,
            _ => return None,
        })
    }
    pub fn as_f64(&self) -> Option<f64> {
        Some(match self {
            Value::Byte(v) => *v as f64,
            Value::Short(v) => *v as f64,
            Value::Int(v) => *v as f64,
            Value::Long(v) => *v as f64,
            Value::Float(v) => *v as f64,
            Value::Double(v) => *v as f64,
            _ => return None,
        })
    }
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }
    pub fn as_list(&self) -> Option<&Vec<Value>> {
        match self {
            Value::List(_, items) => Some(items),
            _ => None,
        }
    }
    pub fn as_compound(&self) -> Option<&Compound> {
        match self {
            Value::Compound(c) => Some(c),
            _ => None,
        }
    }
    pub fn tag(&self) -> u8 {
        match self {
            Value::Byte(_) => BYTE,
            Value::Short(_) => SHORT,
            Value::Int(_) => INT,
            Value::Long(_) => LONG,
            Value::Float(_) => FLOAT,
            Value::Double(_) => DOUBLE,
            Value::ByteArray(_) => BYTE_ARRAY,
            Value::Str(_) => STRING,
            Value::List(..) => LIST,
            Value::Compound(_) => COMPOUND,
            Value::IntArray(_) => INT_ARRAY,
            Value::LongArray(_) => LONG_ARRAY,
        }
    }
}

pub type Keys = Option<Vec<String>>;

fn wanted(set: &Keys, name: &str) -> bool {
    match set {
        None => false,
        Some(list) => list.iter().any(|k| k == name),
    }
}

pub struct Reader<'a> {
    b: &'a [u8],
    o: usize,
    le: bool,
}

type R<T> = Result<T, String>;

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> R<&'a [u8]> {
        let end = self.o.checked_add(n).ok_or("overflow")?;
        let s = self.b.get(self.o..end).ok_or("unexpected end of nbt")?;
        self.o = end;
        Ok(s)
    }
    fn u8(&mut self) -> R<u8> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> R<u16> {
        let s = self.take(2)?;
        Ok(if self.le { u16::from_le_bytes([s[0], s[1]]) } else { u16::from_be_bytes([s[0], s[1]]) })
    }
    fn i32v(&mut self) -> R<i32> {
        let s = self.take(4)?;
        let a = [s[0], s[1], s[2], s[3]];
        Ok(if self.le { i32::from_le_bytes(a) } else { i32::from_be_bytes(a) })
    }
    fn i64v(&mut self) -> R<i64> {
        let s = self.take(8)?;
        let a = [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]];
        Ok(if self.le { i64::from_le_bytes(a) } else { i64::from_be_bytes(a) })
    }
    fn name(&mut self) -> R<String> {
        let n = self.u16()? as usize;
        let s = self.take(n)?;
        Ok(String::from_utf8_lossy(s).into_owned())
    }

    fn skip_payload(&mut self, tag: u8) -> R<()> {
        match tag {
            BYTE => { self.take(1)?; }
            SHORT => { self.take(2)?; }
            INT | FLOAT => { self.take(4)?; }
            LONG | DOUBLE => { self.take(8)?; }
            BYTE_ARRAY => {
                let n = self.i32v()?.max(0) as usize;
                self.take(n)?;
            }
            STRING => {
                let n = self.u16()? as usize;
                self.take(n)?;
            }
            LIST => {
                let t = self.u8()?;
                let n = self.i32v()?.max(0);
                for _ in 0..n {
                    self.skip_payload(t)?;
                }
            }
            COMPOUND => loop {
                let t = self.u8()?;
                if t == END {
                    break;
                }
                let n = self.u16()? as usize;
                self.take(n)?;
                self.skip_payload(t)?;
            },
            INT_ARRAY => {
                let n = self.i32v()?.max(0) as usize;
                self.take(n.checked_mul(4).ok_or("overflow")?)?;
            }
            LONG_ARRAY => {
                let n = self.i32v()?.max(0) as usize;
                self.take(n.checked_mul(8).ok_or("overflow")?)?;
            }
            other => return Err(format!("Unknown NBT tag type {other} at {}", self.o)),
        }
        Ok(())
    }

    fn payload(&mut self, tag: u8, root: bool, skip: &Keys, only: &Keys) -> R<Value> {
        Ok(match tag {
            BYTE => Value::Byte(self.u8()? as i8),
            SHORT => Value::Short(self.u16()? as i16),
            INT => Value::Int(self.i32v()?),
            LONG => Value::Long(self.i64v()?),
            FLOAT => Value::Float(f32::from_bits(self.i32v()? as u32)),
            DOUBLE => Value::Double(f64::from_bits(self.i64v()? as u64)),
            BYTE_ARRAY => {
                let n = self.i32v()?.max(0) as usize;
                Value::ByteArray(self.take(n)?.to_vec())
            }
            STRING => Value::Str(self.name()?),
            LIST => {
                let t = self.u8()?;
                let n = self.i32v()?.max(0) as usize;
                let mut items = Vec::with_capacity(n.min(1 << 16));
                for _ in 0..n {
                    items.push(self.payload(t, false, skip, only)?);
                }
                Value::List(t, items)
            }
            COMPOUND => {
                let mut c = Compound::default();
                loop {
                    let t = self.u8()?;
                    if t == END {
                        break;
                    }
                    let name = self.name()?;
                    if wanted(skip, &name) || (root && only.is_some() && !wanted(only, &name)) {
                        self.skip_payload(t)?;
                    } else {
                        let v = self.payload(t, false, skip, only)?;
                        c.entries.push((name, v));
                    }
                }
                Value::Compound(c)
            }
            INT_ARRAY => {
                let n = self.i32v()?.max(0) as usize;
                let mut a = Vec::with_capacity(n.min(1 << 20));
                for _ in 0..n {
                    a.push(self.i32v()?);
                }
                Value::IntArray(a)
            }
            LONG_ARRAY => {
                let n = self.i32v()?.max(0) as usize;
                let mut a = Vec::with_capacity(n.min(1 << 20));
                for _ in 0..n {
                    a.push(self.i64v()?);
                }
                Value::LongArray(a)
            }
            other => return Err(format!("Unknown NBT tag type {other} at {}", self.o)),
        })
    }
}

pub fn gunzip(bytes: &[u8]) -> Vec<u8> {
    let opts = DeflateOptions::default().set_confirm_checksum(false).set_limit(1 << 30);
    if bytes.len() > 2 && bytes[0] == 0x1f && bytes[1] == 0x8b {
        if let Ok(v) = DeflateDecoder::new_with_options(bytes, opts).decode_gzip() {
            return v;
        }
    }
    bytes.to_vec()
}

pub fn inflate_zlib(bytes: &[u8]) -> Option<Vec<u8>> {
    let opts = DeflateOptions::default().set_confirm_checksum(false).set_limit(1 << 30);
    DeflateDecoder::new_with_options(bytes, opts).decode_zlib().ok()
}

fn parse_once(bytes: &[u8], le: bool, skip: &Keys, only: &Keys) -> R<(Compound, usize)> {
    let mut r = Reader { b: bytes, o: 0, le };
    if r.u8()? != COMPOUND {
        return Err("NBT root is not a compound".into());
    }
    r.name()?;
    match r.payload(COMPOUND, true, skip, only)? {
        Value::Compound(c) => Ok((c, r.o)),
        _ => Err("NBT root is not a compound".into()),
    }
}

/// `little_endian` forces the endianness; otherwise both are tried.
pub fn read_nbt(input: &[u8], little_endian: Option<bool>, skip: &Keys, only: &Keys) -> R<Compound> {
    let bytes = gunzip(input);
    if let Some(le) = little_endian {
        return parse_once(&bytes, le, skip, only).map(|(c, _)| c);
    }
    let mut first: Option<String> = None;
    let mut partial: Option<Compound> = None;
    for le in [false, true] {
        match parse_once(&bytes, le, skip, only) {
            Ok((root, end)) => {
                if end == bytes.len() {
                    return Ok(root);
                }
                if partial.is_none() {
                    partial = Some(root);
                }
            }
            Err(e) => {
                if first.is_none() {
                    first = Some(e);
                }
            }
        }
    }
    partial.ok_or_else(|| format!("not NBT data, in either endianness: {}", first.unwrap_or_default()))
}


pub struct Writer {
    pub out: Vec<u8>,
}

impl Writer {
    pub fn new() -> Self {
        Writer { out: Vec::new() }
    }
    fn str(&mut self, s: &str) {
        let b = s.as_bytes();
        self.out.extend_from_slice(&(b.len() as u16).to_be_bytes());
        self.out.extend_from_slice(b);
    }
    pub fn value(&mut self, v: &Value) {
        match v {
            Value::Byte(x) => self.out.push(*x as u8),
            Value::Short(x) => self.out.extend_from_slice(&x.to_be_bytes()),
            Value::Int(x) => self.out.extend_from_slice(&x.to_be_bytes()),
            Value::Long(x) => self.out.extend_from_slice(&x.to_be_bytes()),
            Value::Float(x) => self.out.extend_from_slice(&x.to_bits().to_be_bytes()),
            Value::Double(x) => self.out.extend_from_slice(&x.to_bits().to_be_bytes()),
            Value::ByteArray(a) => {
                self.out.extend_from_slice(&(a.len() as i32).to_be_bytes());
                self.out.extend_from_slice(a);
            }
            Value::Str(s) => self.str(s),
            Value::List(t, items) => {
                let tag = if items.is_empty() { *t } else { items[0].tag() };
                self.out.push(tag);
                self.out.extend_from_slice(&(items.len() as i32).to_be_bytes());
                for it in items {
                    self.value(it);
                }
            }
            Value::Compound(c) => {
                for (k, val) in &c.entries {
                    self.out.push(val.tag());
                    self.str(k);
                    self.value(val);
                }
                self.out.push(END);
            }
            Value::IntArray(a) => {
                self.out.extend_from_slice(&(a.len() as i32).to_be_bytes());
                for x in a {
                    self.out.extend_from_slice(&x.to_be_bytes());
                }
            }
            Value::LongArray(a) => {
                self.out.extend_from_slice(&(a.len() as i32).to_be_bytes());
                for x in a {
                    self.out.extend_from_slice(&x.to_be_bytes());
                }
            }
        }
    }
    /// A whole file: root compound with an empty name.
    pub fn root(mut self, c: &Compound) -> Vec<u8> {
        self.out.push(COMPOUND);
        self.str("");
        self.value(&Value::Compound(c.clone()));
        self.out
    }
}

/// Only used where a stable key is needed, never for output ordering.
pub fn sorted(c: &Compound) -> BTreeMap<&str, &Value> {
    c.entries.iter().map(|(k, v)| (k.as_str(), v)).collect()
}
