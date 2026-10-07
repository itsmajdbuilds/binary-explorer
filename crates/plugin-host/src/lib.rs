//! Declarative format plugins (plan §18 — plugin architecture, Phase A).
//!
//! A *plugin* is a single self-contained TOML file that teaches the app new
//! formats without any code. Each plugin declares one or more formats; each
//! format carries a magic-number detection rule and an inline schema (the same
//! DSL the built-ins use). This crate is **pure**: it parses a manifest and
//! matches detection rules against bytes. It knows nothing about the filesystem
//! or the schema language — the app layer owns installing/removing plugin files
//! and validating the embedded schemas.
//!
//! Manifest shape:
//!
//! ```toml
//! id = "com.example.tga"
//! name = "Truevision TGA"
//! version = "0.1.0"
//! description = "TARGA image header"
//! author = "you"
//!
//! [[formats]]
//! name = "TGA"
//! extension = "tga"
//! description = "Truevision TARGA image"
//! confidence = 70
//! detect = [ { offset = 0, hex = "00 00 02" } ]
//! entry = "TgaHeader"
//! endian = "le"
//! schema = """
//! struct TgaHeader { idLength u8  colorMapType u8  imageType u8 }
//! """
//! ```

use serde::{Deserialize, Serialize};

/// A parsed plugin manifest.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct PluginManifest {
    /// Stable, unique id, e.g. `"com.example.tga"`.
    pub id: String,
    /// Human-readable plugin name.
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    /// The formats this plugin contributes.
    #[serde(default)]
    pub formats: Vec<FormatDef>,
}

/// One format a plugin contributes: how to recognize it and how to parse it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct FormatDef {
    /// Short format name, e.g. `"TGA"`. Used as the detection/schema key.
    pub name: String,
    #[serde(default)]
    pub extension: String,
    #[serde(default)]
    pub description: String,
    /// Detection confidence 0-100 (longer/more specific magic scores higher).
    #[serde(default = "default_confidence")]
    pub confidence: u8,
    /// Signature parts; **all** must match for the format to be detected. An
    /// empty list means the format never auto-detects (still loadable by hand).
    #[serde(default)]
    pub detect: Vec<DetectPart>,
    /// Entry struct for the schema (empty = the schema's first struct).
    #[serde(default)]
    pub entry: String,
    /// `"le"` or `"be"`; defaults to `"le"`.
    #[serde(default = "default_endian")]
    pub endian: String,
    /// The inline schema DSL text.
    pub schema: String,
}

/// One `(offset, bytes)` signature part. The bytes are written as hex.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct DetectPart {
    #[serde(default)]
    pub offset: usize,
    /// Hex bytes to match, e.g. `"89 50 4e 47"` (whitespace ignored).
    pub hex: String,
}

fn default_confidence() -> u8 {
    75
}
fn default_endian() -> String {
    "le".to_string()
}

impl PluginManifest {
    /// Parse a manifest from TOML text.
    pub fn parse(text: &str) -> Result<Self, String> {
        toml::from_str(text).map_err(|e| e.message().to_string())
    }

    /// Check the manifest is well-formed: required fields present, and every
    /// detection rule's hex is valid. (Schema *content* is validated by the app
    /// layer, which owns the parser.)
    pub fn validate(&self) -> Result<(), String> {
        if self.id.trim().is_empty() {
            return Err("plugin `id` is required".into());
        }
        if self.name.trim().is_empty() {
            return Err("plugin `name` is required".into());
        }
        for f in &self.formats {
            if f.name.trim().is_empty() {
                return Err("every format needs a `name`".into());
            }
            if f.schema.trim().is_empty() {
                return Err(format!("format `{}` has an empty schema", f.name));
            }
            for p in &f.detect {
                parse_hex(&p.hex)
                    .map_err(|e| format!("format `{}` has invalid detect hex: {e}", f.name))?;
            }
        }
        Ok(())
    }

    /// Return the formats whose detection rules all match `head` (the start of a
    /// file), most-confident first.
    pub fn matches(&self, head: &[u8]) -> Vec<&FormatDef> {
        let mut hits: Vec<&FormatDef> =
            self.formats.iter().filter(|f| f.detect_matches(head)).collect();
        hits.sort_by(|a, b| b.confidence.cmp(&a.confidence));
        hits
    }

    /// Find a contributed format by its `name`.
    pub fn format(&self, name: &str) -> Option<&FormatDef> {
        self.formats.iter().find(|f| f.name == name)
    }
}

impl FormatDef {
    /// True when every detection part matches (and there is at least one part).
    pub fn detect_matches(&self, head: &[u8]) -> bool {
        if self.detect.is_empty() {
            return false;
        }
        self.detect.iter().all(|p| p.matches(head))
    }
}

impl DetectPart {
    /// True when these bytes sit at `offset` in `head`.
    pub fn matches(&self, head: &[u8]) -> bool {
        let Ok(bytes) = parse_hex(&self.hex) else {
            return false;
        };
        if bytes.is_empty() {
            return false;
        }
        let end = self.offset.saturating_add(bytes.len());
        head.len() >= end && head[self.offset..end] == bytes[..]
    }
}

/// Parse a hex string (whitespace ignored) into bytes. Requires an even number
/// of hex digits.
pub fn parse_hex(s: &str) -> Result<Vec<u8>, String> {
    let cleaned: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    if cleaned.len() % 2 != 0 {
        return Err(format!("odd number of hex digits in `{s}`"));
    }
    let mut out = Vec::with_capacity(cleaned.len() / 2);
    let bytes = cleaned.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let hi = hex_val(bytes[i])?;
        let lo = hex_val(bytes[i + 1])?;
        out.push((hi << 4) | lo);
        i += 2;
    }
    Ok(out)
}

fn hex_val(b: u8) -> Result<u8, String> {
    match b {
        b'0'..=b'9' => Ok(b - b'0'),
        b'a'..=b'f' => Ok(b - b'a' + 10),
        b'A'..=b'F' => Ok(b - b'A' + 10),
        _ => Err(format!("not a hex digit: `{}`", b as char)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
id = "com.example.png2"
name = "PNG (plugin)"
version = "0.1.0"
description = "a PNG variant"
author = "tester"

[[formats]]
name = "PNG2"
extension = "png"
description = "PNG magic"
confidence = 90
detect = [ { offset = 0, hex = "89 50 4E 47" } ]
entry = "PNG"
endian = "be"
schema = "struct PNG { sig bytes[8] }"
"#;

    #[test]
    fn parses_a_manifest() {
        let m = PluginManifest::parse(SAMPLE).unwrap();
        assert_eq!(m.id, "com.example.png2");
        assert_eq!(m.formats.len(), 1);
        let f = &m.formats[0];
        assert_eq!(f.name, "PNG2");
        assert_eq!(f.confidence, 90);
        assert_eq!(f.endian, "be");
        assert_eq!(f.detect[0].offset, 0);
    }

    #[test]
    fn defaults_apply() {
        let m = PluginManifest::parse(
            r#"
id = "x"
name = "X"
[[formats]]
name = "F"
schema = "struct F { a u8 }"
"#,
        )
        .unwrap();
        let f = &m.formats[0];
        assert_eq!(f.confidence, 75); // default
        assert_eq!(f.endian, "le"); // default
        assert!(f.detect.is_empty());
    }

    #[test]
    fn detection_matches_on_magic() {
        let m = PluginManifest::parse(SAMPLE).unwrap();
        let png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        let hits = m.matches(&png);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].name, "PNG2");

        // Wrong magic -> no match.
        assert!(m.matches(&[0, 1, 2, 3, 4, 5, 6, 7]).is_empty());
        // Too-short head -> no match, no panic.
        assert!(m.matches(&[0x89, 0x50]).is_empty());
    }

    #[test]
    fn empty_detect_never_auto_matches() {
        let m = PluginManifest::parse(
            r#"
id = "x"
name = "X"
[[formats]]
name = "F"
schema = "struct F { a u8 }"
"#,
        )
        .unwrap();
        assert!(m.matches(&[0; 16]).is_empty());
    }

    #[test]
    fn validate_catches_problems() {
        assert!(PluginManifest::parse("id = \"\"\nname = \"X\"").unwrap().validate().is_err());
        let bad_hex = PluginManifest::parse(
            r#"
id = "x"
name = "X"
[[formats]]
name = "F"
detect = [ { offset = 0, hex = "zz" } ]
schema = "struct F { a u8 }"
"#,
        )
        .unwrap();
        assert!(bad_hex.validate().is_err());
    }

    #[test]
    fn hex_parsing() {
        assert_eq!(parse_hex("89 50 4e 47").unwrap(), vec![0x89, 0x50, 0x4e, 0x47]);
        assert_eq!(parse_hex("FFD8FF").unwrap(), vec![0xFF, 0xD8, 0xFF]);
        assert!(parse_hex("abc").is_err()); // odd length
        assert!(parse_hex("zz").is_err()); // not hex
    }
}
