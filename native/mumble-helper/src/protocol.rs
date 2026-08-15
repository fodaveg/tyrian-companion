use getrandom::fill;
use std::borrow::Borrow;
use std::collections::BTreeMap;
use subtle::ConstantTimeEq;
use zeroize::Zeroize;

pub const VERSION: u64 = 1;
pub const HEARTBEAT_INTERVAL_MS: u64 = 500;
pub const HEARTBEAT_TIMEOUT_MS: u64 = 2_000;
pub const SOURCE_STALLED_AFTER_MS: u64 = 1_500;
pub const HELLO_TIMEOUT_MS: u64 = 2_000;
pub const MAX_SEQUENCE: u64 = 9_007_199_254_740_991;

pub struct ProcessToken([u8; 32]);

impl Drop for ProcessToken {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl ProcessToken {
    pub fn parse(encoded: &str) -> Result<Self, ProtocolError> {
        let bytes = decode_base64url::<32>(encoded).ok_or(ProtocolError::Schema)?;
        Ok(Self(bytes))
    }

    pub fn matches_encoded(&self, encoded: &str) -> bool {
        let mut candidate = match decode_base64url::<32>(encoded) {
            Some(value) => value,
            None => return false,
        };
        let matches = bool::from(self.0.ct_eq(&candidate));
        candidate.zeroize();
        matches
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtocolError {
    Json,
    Schema,
    Version,
    Auth,
    Random,
    Sequence,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Bootstrap {
    pub token: String,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Hello {
    pub token: String,
}

pub fn parse_bootstrap(source: &str) -> Result<Bootstrap, ProtocolError> {
    let mut object = parse_object(source)?;
    require_keys(&object, &["kind", "version", "token"])?;
    require_version(&object)?;
    if string(&object, "kind")? != "bootstrap" {
        return Err(ProtocolError::Schema);
    }
    let token = take_string(&mut object, "token")?;
    if ProcessToken::parse(&token).is_err() {
        let mut rejected = token;
        rejected.zeroize();
        return Err(ProtocolError::Schema);
    }
    Ok(Bootstrap { token })
}

pub fn parse_hello(source: &str) -> Result<Hello, ProtocolError> {
    let mut object = parse_object(source)?;
    require_keys(&object, &["kind", "version", "token"])?;
    require_version(&object)?;
    if string(&object, "kind")? != "hello" {
        return Err(ProtocolError::Schema);
    }
    let token = take_string(&mut object, "token")?;
    if ProcessToken::parse(&token).is_err() {
        let mut rejected = token;
        rejected.zeroize();
        return Err(ProtocolError::Schema);
    }
    Ok(Hello { token })
}

pub fn ready(port: u16) -> String {
    format!(r#"{{"kind":"ready","version":1,"host":"127.0.0.1","port":{port}}}"#)
}

pub fn welcome(nonce: &str) -> String {
    format!(r#"{{"kind":"welcome","version":1,"nonce":"{nonce}","heartbeatIntervalMs":500}}"#,)
}

pub fn heartbeat(nonce: &str, sequence: u64, status: SourceStatus) -> String {
    format!(
        r#"{{"kind":"heartbeat","version":1,"nonce":"{nonce}","sequence":{sequence},"sourceStatus":"{}"}}"#,
        status.as_str(),
    )
}

pub fn sample(nonce: &str, sequence: u64, tick: u32, map_id: u32, activity: Activity) -> String {
    format!(
        r#"{{"version":1,"nonce":"{nonce}","sequence":{sequence},"tick":{tick},"mapId":{map_id},"activity":"{}"}}"#,
        activity.as_str(),
    )
}

pub fn fresh_nonce() -> Result<String, ProtocolError> {
    let mut bytes = [0_u8; 16];
    fill(&mut bytes).map_err(|_| ProtocolError::Random)?;
    let encoded = encode_base64url(&bytes);
    bytes.zeroize();
    debug_assert_eq!(encoded.len(), 22);
    Ok(encoded)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceStatus {
    WarmingUp,
    MappingUnavailable,
    LayoutUnsupported,
    SampleUnstable,
    SampleInvalid,
}

impl SourceStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::WarmingUp => "warming_up",
            Self::MappingUnavailable => "mapping_unavailable",
            Self::LayoutUnsupported => "layout_unsupported",
            Self::SampleUnstable => "sample_unstable",
            Self::SampleInvalid => "sample_invalid",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Activity {
    Advancing,
    Stalled,
}

impl Activity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Advancing => "link_advancing",
            Self::Stalled => "link_stalled",
        }
    }
}

#[derive(Default)]
pub struct Sequence {
    next: u64,
}

impl Sequence {
    pub fn take(&mut self) -> Result<u64, ProtocolError> {
        if self.next > MAX_SEQUENCE {
            return Err(ProtocolError::Sequence);
        }
        let current = self.next;
        self.next = self.next.checked_add(1).ok_or(ProtocolError::Sequence)?;
        Ok(current)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, PartialOrd, Ord)]
struct SecretString(String);

impl Borrow<str> for SecretString {
    fn borrow(&self) -> &str {
        &self.0
    }
}

impl Drop for SecretString {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum JsonValue {
    String(SecretString),
    Number(u64),
    Other,
}

fn parse_object(source: &str) -> Result<BTreeMap<SecretString, JsonValue>, ProtocolError> {
    let mut parser = Parser {
        bytes: source.as_bytes(),
        offset: 0,
    };
    parser.space();
    parser.byte(b'{')?;
    let mut object = BTreeMap::new();
    parser.space();
    if parser.peek() != Some(b'}') {
        loop {
            let key = parser.string()?;
            parser.space();
            parser.byte(b':')?;
            parser.space();
            let value = parser.value()?;
            if object.insert(key, value).is_some() {
                return Err(ProtocolError::Schema);
            }
            parser.space();
            match parser.peek() {
                Some(b',') => {
                    parser.offset += 1;
                    parser.space();
                }
                Some(b'}') => break,
                _ => return Err(ProtocolError::Json),
            }
        }
    }
    parser.byte(b'}')?;
    parser.space();
    if parser.offset != parser.bytes.len() {
        return Err(ProtocolError::Json);
    }
    Ok(object)
}

fn require_keys(
    object: &BTreeMap<SecretString, JsonValue>,
    keys: &[&str],
) -> Result<(), ProtocolError> {
    if object.len() != keys.len() || keys.iter().any(|key| !object.contains_key(*key)) {
        return Err(ProtocolError::Schema);
    }
    Ok(())
}

fn require_version(object: &BTreeMap<SecretString, JsonValue>) -> Result<(), ProtocolError> {
    match object.get("version") {
        Some(JsonValue::Number(VERSION)) => Ok(()),
        Some(JsonValue::Number(_)) => Err(ProtocolError::Version),
        _ => Err(ProtocolError::Schema),
    }
}

fn string<'a>(
    object: &'a BTreeMap<SecretString, JsonValue>,
    key: &str,
) -> Result<&'a str, ProtocolError> {
    match object.get(key) {
        Some(JsonValue::String(value)) => Ok(&value.0),
        _ => Err(ProtocolError::Schema),
    }
}

fn take_string(
    object: &mut BTreeMap<SecretString, JsonValue>,
    key: &str,
) -> Result<String, ProtocolError> {
    match object.get_mut(key) {
        Some(JsonValue::String(value)) => Ok(std::mem::take(&mut value.0)),
        _ => Err(ProtocolError::Schema),
    }
}

struct Parser<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl Parser<'_> {
    fn value(&mut self) -> Result<JsonValue, ProtocolError> {
        match self.peek() {
            Some(b'"') => self.string().map(JsonValue::String),
            Some(b'-' | b'0'..=b'9') => self.number(),
            Some(b'{') | Some(b'[') => {
                self.composite()?;
                Ok(JsonValue::Other)
            }
            Some(b't') => self.literal(b"true").map(|()| JsonValue::Other),
            Some(b'f') => self.literal(b"false").map(|()| JsonValue::Other),
            Some(b'n') => self.literal(b"null").map(|()| JsonValue::Other),
            _ => Err(ProtocolError::Json),
        }
    }

    fn composite(&mut self) -> Result<(), ProtocolError> {
        let open = self.peek().ok_or(ProtocolError::Json)?;
        let close = if open == b'{' { b'}' } else { b']' };
        self.offset += 1;
        loop {
            match self.peek().ok_or(ProtocolError::Json)? {
                b'"' => {
                    self.string()?;
                }
                byte if byte == open => self.composite()?,
                byte if byte == close => {
                    self.offset += 1;
                    return Ok(());
                }
                b'\\' => return Err(ProtocolError::Json),
                _ => self.offset += 1,
            }
        }
    }

    fn string(&mut self) -> Result<SecretString, ProtocolError> {
        self.byte(b'"')?;
        let mut output = SecretString::default();
        loop {
            let byte = self.peek().ok_or(ProtocolError::Json)?;
            self.offset += 1;
            match byte {
                b'"' => return Ok(output),
                b'\\' => self.escape(&mut output)?,
                0x00..=0x1f => return Err(ProtocolError::Json),
                0x20..=0x7f => output.0.push(char::from(byte)),
                _ => {
                    let start = self.offset - 1;
                    let tail = std::str::from_utf8(&self.bytes[start..])
                        .map_err(|_| ProtocolError::Json)?;
                    let character = tail.chars().next().ok_or(ProtocolError::Json)?;
                    output.0.push(character);
                    self.offset = start + character.len_utf8();
                }
            }
        }
    }

    fn escape(&mut self, output: &mut SecretString) -> Result<(), ProtocolError> {
        let escaped = self.peek().ok_or(ProtocolError::Json)?;
        self.offset += 1;
        match escaped {
            b'"' => output.0.push('"'),
            b'\\' => output.0.push('\\'),
            b'/' => output.0.push('/'),
            b'b' => output.0.push('\u{0008}'),
            b'f' => output.0.push('\u{000c}'),
            b'n' => output.0.push('\n'),
            b'r' => output.0.push('\r'),
            b't' => output.0.push('\t'),
            b'u' => {
                let code = self.hex4()?;
                let character = char::from_u32(code).ok_or(ProtocolError::Json)?;
                output.0.push(character);
            }
            _ => return Err(ProtocolError::Json),
        }
        Ok(())
    }

    fn hex4(&mut self) -> Result<u32, ProtocolError> {
        let end = self.offset.checked_add(4).ok_or(ProtocolError::Json)?;
        let digits = self
            .bytes
            .get(self.offset..end)
            .ok_or(ProtocolError::Json)?;
        self.offset = end;
        digits.iter().try_fold(0_u32, |value, byte| {
            let digit = match byte {
                b'0'..=b'9' => byte - b'0',
                b'a'..=b'f' => byte - b'a' + 10,
                b'A'..=b'F' => byte - b'A' + 10,
                _ => return Err(ProtocolError::Json),
            };
            Ok(value * 16 + u32::from(digit))
        })
    }

    fn number(&mut self) -> Result<JsonValue, ProtocolError> {
        let start = self.offset;
        if self.peek() == Some(b'-') {
            self.offset += 1;
        }
        match self.peek() {
            Some(b'0') => self.offset += 1,
            Some(b'1'..=b'9') => {
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.offset += 1;
                }
            }
            _ => return Err(ProtocolError::Json),
        }
        if self.peek() == Some(b'.') {
            self.offset += 1;
            let fraction_start = self.offset;
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.offset += 1;
            }
            if self.offset == fraction_start {
                return Err(ProtocolError::Json);
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.offset += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.offset += 1;
            }
            let exponent_start = self.offset;
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.offset += 1;
            }
            if self.offset == exponent_start {
                return Err(ProtocolError::Json);
            }
        }
        let source = std::str::from_utf8(&self.bytes[start..self.offset])
            .map_err(|_| ProtocolError::Json)?;
        let number = source.parse::<f64>().map_err(|_| ProtocolError::Json)?;
        if number.is_finite()
            && number >= 0.0
            && number.fract() == 0.0
            && number <= MAX_SEQUENCE as f64
        {
            Ok(JsonValue::Number(number as u64))
        } else {
            Ok(JsonValue::Other)
        }
    }

    fn literal(&mut self, expected: &[u8]) -> Result<(), ProtocolError> {
        if self.bytes.get(self.offset..self.offset + expected.len()) != Some(expected) {
            return Err(ProtocolError::Json);
        }
        self.offset += expected.len();
        Ok(())
    }

    fn byte(&mut self, expected: u8) -> Result<(), ProtocolError> {
        if self.peek() != Some(expected) {
            return Err(ProtocolError::Json);
        }
        self.offset += 1;
        Ok(())
    }

    fn space(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            self.offset += 1;
        }
    }
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.offset).copied()
    }
}

fn decode_base64url<const N: usize>(source: &str) -> Option<[u8; N]> {
    let expected = (N * 8 + 5) / 6;
    if source.len() != expected || source.contains('=') {
        return None;
    }
    let mut output = [0_u8; N];
    let mut accumulator = 0_u32;
    let mut bits = 0_u8;
    let mut written = 0;
    for byte in source.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => {
                output.zeroize();
                accumulator.zeroize();
                return None;
            }
        };
        accumulator = (accumulator << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            if written >= N {
                output.zeroize();
                accumulator.zeroize();
                return None;
            }
            output[written] = (accumulator >> bits) as u8;
            written += 1;
            accumulator &= (1_u32 << bits) - 1;
        }
    }
    if written == N && accumulator == 0 {
        Some(output)
    } else {
        output.zeroize();
        accumulator.zeroize();
        None
    }
}

fn encode_base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut output = String::with_capacity((bytes.len() * 8 + 5) / 6);
    let mut accumulator = 0_u32;
    let mut bits = 0_u8;
    for &byte in bytes {
        accumulator = (accumulator << 8) | u32::from(byte);
        bits += 8;
        while bits >= 6 {
            bits -= 6;
            output.push(char::from(ALPHABET[((accumulator >> bits) & 63) as usize]));
            accumulator &= (1_u32 << bits) - 1;
        }
    }
    if bits > 0 {
        output.push(char::from(ALPHABET[(accumulator << (6 - bits)) as usize]));
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN_A: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const TOKEN_B: &str = "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    #[test]
    fn strict_bootstrap_and_constant_time_auth() {
        let bootstrap = parse_bootstrap(&format!(
            r#"{{"kind":"bootstrap","version":1,"token":"{TOKEN_A}"}}"#
        ))
        .unwrap();
        let token = ProcessToken::parse(&bootstrap.token).unwrap();
        assert!(token.matches_encoded(TOKEN_A));
        assert!(!token.matches_encoded(TOKEN_B));
        assert!(!token.matches_encoded("short"));
        assert!(parse_bootstrap(&format!(
            r#"{{"kind":"bootstrap","version":1.0e0,"token":"{TOKEN_A}"}}"#
        ))
        .is_ok());
    }

    #[test]
    fn rejects_extra_missing_duplicate_trailing_and_downgrade() {
        for source in [
            format!(r#"{{"kind":"bootstrap","version":1,"token":"{TOKEN_A}","pid":7}}"#),
            r#"{"kind":"bootstrap","version":1}"#.to_owned(),
            format!(
                r#"{{"kind":"bootstrap","k\u0069nd":"bootstrap","version":1,"token":"{TOKEN_A}"}}"#
            ),
            format!(r#"{{"kind":"bootstrap","version":1,"token":"{TOKEN_A}"}} false"#),
        ] {
            assert!(parse_bootstrap(&source).is_err(), "accepted {source}");
        }
        assert_eq!(
            parse_bootstrap(&format!(
                r#"{{"kind":"bootstrap","version":0,"token":"{TOKEN_A}"}}"#
            )),
            Err(ProtocolError::Version)
        );
    }

    #[test]
    fn exact_records_nonce_and_shared_sequence() {
        let nonce = fresh_nonce().unwrap();
        assert_eq!(nonce.len(), 22);
        let mut sequence = Sequence::default();
        assert!(
            heartbeat(&nonce, sequence.take().unwrap(), SourceStatus::WarmingUp)
                .contains(r#""sequence":0"#)
        );
        assert!(sample(
            &nonce,
            sequence.take().unwrap(),
            u32::MAX,
            866,
            Activity::Advancing
        )
        .contains(r#""sequence":1"#));
        assert_eq!(
            welcome(&nonce),
            format!(
                r#"{{"kind":"welcome","version":1,"nonce":"{nonce}","heartbeatIntervalMs":500}}"#
            )
        );
    }

    #[test]
    fn sequence_rejects_wrap_after_safe_maximum() {
        let mut sequence = Sequence { next: MAX_SEQUENCE };
        assert_eq!(sequence.take(), Ok(MAX_SEQUENCE));
        assert_eq!(sequence.take(), Err(ProtocolError::Sequence));
    }
}
