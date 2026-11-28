//! JavaScript semantics the TypeScript planner relies on, reproduced exactly
//! so captions, coordinates and request bodies come out byte for byte the
//! same: `Number.prototype.toFixed`, `Math.round`, `Number.prototype.toString`,
//! UTF-16 string slicing, the `\s` whitespace class, and `JSON.stringify`.

/// `Math.round`: halves round toward positive infinity (`Math.round(-2.5)` is -2).
pub(crate) fn round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let floor = x.floor();
    if x - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// `Number.prototype.toFixed(digits)` for finite numbers below 1e21.
///
/// JavaScript rounds an exact tie up (away from zero), where Rust's `{:.N}`
/// rounds it to even: `(0.03125).toFixed(4)` is "0.0313", `format!("{:.4}")`
/// gives "0.0312". The digits are taken from an expansion long enough that
/// only a true tie can look like one.
pub(crate) fn to_fixed(x: f64, digits: usize) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() || x.abs() >= 1e21 {
        return to_js_string(x);
    }
    if x < 0.0 {
        return format!("-{}", to_fixed(-x, digits));
    }
    // 60 extra digits: for any double that is not tiny, the distance to a
    // tie at `digits + 1` places is far larger than 10^-(digits + 60).
    let long = format!("{:.*}", digits + 60, x);
    let (int_part, frac) = long.split_once('.').unwrap_or((long.as_str(), ""));
    let mut kept: Vec<u8> = int_part.bytes().chain(frac.bytes().take(digits)).collect();
    let rest = &frac.as_bytes()[digits.min(frac.len())..];
    let round_up = rest.first().is_some_and(|d| *d >= b'5');
    if round_up {
        let mut i = kept.len();
        loop {
            if i == 0 {
                kept.insert(0, b'1');
                break;
            }
            i -= 1;
            if kept[i] == b'9' {
                kept[i] = b'0';
            } else {
                kept[i] += 1;
                break;
            }
        }
    }
    let int_len = kept.len() - digits;
    let mut out = String::with_capacity(kept.len() + 1);
    out.push_str(std::str::from_utf8(&kept[..int_len]).unwrap_or("0"));
    if digits > 0 {
        out.push('.');
        out.push_str(std::str::from_utf8(&kept[int_len..]).unwrap_or(""));
    }
    out
}

/// `Number(x.toFixed(digits))`.
pub(crate) fn fixed_number(x: f64, digits: usize) -> f64 {
    to_fixed(x, digits).parse().unwrap_or(x)
}

/// `Number.prototype.toString()` (what `JSON.stringify` and template strings print).
pub(crate) fn to_js_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x.is_infinite() {
        return if x > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        };
    }
    if x < 0.0 {
        return format!("-{}", to_js_string(-x));
    }
    // Rust's `{:e}` prints the shortest digits that round-trip, as JavaScript does.
    let sci = format!("{x:e}");
    let (mantissa, exp) = sci.split_once('e').unwrap_or((sci.as_str(), "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let exp: i32 = exp.parse().unwrap_or(0);
    let k = digits.len() as i32;
    let n = exp + 1;
    if k <= n && n <= 21 {
        return format!("{digits}{}", "0".repeat((n - k) as usize));
    }
    if 0 < n && n <= 21 {
        let (a, b) = digits.split_at(n as usize);
        return format!("{a}.{b}");
    }
    if -6 < n && n <= 0 {
        return format!("0.{}{digits}", "0".repeat((-n) as usize));
    }
    let e = n - 1;
    let sign = if e < 0 { '-' } else { '+' };
    if k == 1 {
        format!("{digits}e{sign}{}", e.abs())
    } else {
        format!("{}.{}e{sign}{}", &digits[..1], &digits[1..], e.abs())
    }
}

/// `s.length`: the length in UTF-16 code units.
pub(crate) fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `s.slice(0, n)`. A cut through a surrogate pair leaves half of it in
/// JavaScript; a Rust string cannot hold that, so it becomes U+FFFD, which is
/// what any UTF-8 encoder makes of the JavaScript result.
pub(crate) fn slice_utf16(s: &str, n: usize) -> String {
    if utf16_len(s) <= n {
        return s.to_string();
    }
    let units: Vec<u16> = s.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&units)
}

/// `s.slice(0, n)` as UTF-16 code units. Unlike [`slice_utf16`], a cut through
/// a surrogate pair keeps the lone half, so the result compares like the
/// JavaScript string does.
pub(crate) fn slice_utf16_units(s: &str, n: usize) -> Vec<u16> {
    s.encode_utf16().take(n).collect()
}

/// The `\s` class of JavaScript regular expressions, which `String.prototype.trim` also uses.
pub(crate) fn is_space(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'..='\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

/// `String.prototype.trim`.
pub(crate) fn trim(s: &str) -> &str {
    s.trim_matches(is_space)
}

/// `s.replace(/\s+/g, ' ')`.
pub(crate) fn collapse_spaces(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_space = false;
    for c in s.chars() {
        if is_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

/// A JSON value written the way `JSON.stringify` writes it: keys in insertion
/// order, numbers as JavaScript prints them, no whitespace.
#[derive(Clone, Debug)]
pub(crate) enum Json {
    Null,
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    pub(crate) fn obj() -> Self {
        Json::Obj(Vec::new())
    }

    /// Adds a key (builder style).
    pub(crate) fn with(mut self, key: &str, value: Json) -> Self {
        if let Json::Obj(entries) = &mut self {
            entries.push((key.to_string(), value));
        }
        self
    }

    /// Adds a key only when there is a value, like an `undefined` property.
    pub(crate) fn with_opt(self, key: &str, value: Option<Json>) -> Self {
        match value {
            Some(v) => self.with(key, v),
            None => self,
        }
    }

    pub(crate) fn write(&self, out: &mut String) {
        match self {
            Json::Null => out.push_str("null"),
            // JSON.stringify writes non-finite numbers as null.
            Json::Num(n) if !n.is_finite() => out.push_str("null"),
            Json::Num(n) => out.push_str(&to_js_string(*n)),
            Json::Str(s) => write_str(s, out),
            Json::Arr(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    item.write(out);
                }
                out.push(']');
            }
            Json::Obj(entries) => {
                out.push('{');
                for (i, (key, value)) in entries.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write_str(key, out);
                    out.push(':');
                    value.write(out);
                }
                out.push('}');
            }
        }
    }

    pub(crate) fn to_json_string(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }
}

/// A JSON string literal as `JSON.stringify` writes it.
fn write_str(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0C}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_fixed_matches_javascript() {
        assert_eq!(to_fixed(0.03125, 4), "0.0313");
        assert_eq!(to_fixed(2.25, 1), "2.3");
        assert_eq!(to_fixed(0.5, 0), "1");
        assert_eq!(to_fixed(1.0000005, 6), "1.000001");
        assert_eq!(to_fixed(0.1, 1), "0.1");
        assert_eq!(to_fixed(1.45, 1), "1.4"); // 1.45 is stored just below 1.45
        assert_eq!(to_fixed(9.99996, 4), "10.0000");
        assert_eq!(to_fixed(0.0, 4), "0.0000");
        assert_eq!(to_fixed(-0.03125, 4), "-0.0313");
        assert_eq!(to_fixed(2600.0, 1), "2600.0");
    }

    #[test]
    fn number_to_string_matches_javascript() {
        for (x, s) in [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (2.6, "2.6"),
            (4096.0, "4096"),
            (0.0001, "0.0001"),
            (1e-7, "1e-7"),
            (1.5e-6, "0.0000015"),
            (1e21, "1e+21"),
            (123456789012345680000.0, "123456789012345680000"),
            (-12.5, "-12.5"),
            (0.1 + 0.2, "0.30000000000000004"),
        ] {
            assert_eq!(to_js_string(x), s, "{x}");
        }
    }

    #[test]
    fn math_round_rounds_halves_up() {
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(0.49999999999999994), 0.0);
        assert_eq!(round(20223.382), 20223.0);
    }

    #[test]
    fn utf16_slicing_and_whitespace() {
        assert_eq!(slice_utf16("ab\u{1F600}c", 3), "ab\u{FFFD}");
        assert_eq!(slice_utf16("ab\u{1F600}c", 4), "ab\u{1F600}");
        assert_eq!(utf16_len("\u{1F600}"), 2);
        assert_eq!(slice_utf16_units("a\u{1F600}", 2), vec![0x61, 0xD83D]);
        assert_ne!(
            slice_utf16_units("a\u{1F600}", 2),
            slice_utf16_units("a\u{1F9ED}", 2)
        );
        assert_eq!(trim("\u{FEFF} a \u{2028}"), "a");
        assert_eq!(trim("\u{85}a"), "\u{85}a"); // NEL is not JavaScript whitespace
        assert_eq!(collapse_spaces(" a \n\t b "), " a b ");
    }

    #[test]
    fn json_matches_stringify() {
        let v = Json::obj()
            .with("a", Json::Num(1.0))
            .with("b", Json::Str("q\"\\\n\u{1}\u{2028}".into()))
            .with_opt("c", None)
            .with("d", Json::Arr(vec![Json::Null, Json::Num(0.5)]));
        assert_eq!(
            v.to_json_string(),
            "{\"a\":1,\"b\":\"q\\\"\\\\\\n\\u0001\u{2028}\",\"d\":[null,0.5]}"
        );
    }
}
