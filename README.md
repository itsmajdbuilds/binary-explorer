# Nybble

**A visual binary structure explorer.** Point it at a file, describe the layout
in a small declarative schema, and watch the raw bytes turn into a navigable
tree — every field mapped back to the exact bytes it came from, and back again.

Nybble is built for the moment you're staring at a binary nobody has a template
for: a save file, a firmware blob, an undocumented network capture, a custom
container. Instead of a write–compile–stare loop, you edit a schema and the
parse updates live, with bidirectional byte ↔ field highlighting so you always
know what maps to what.

Native, offline, and fast — Rust + Tauri, no telemetry, your bytes never leave
your machine.

---

## See it work

`demos/wasm/` contains a real, spec-valid WebAssembly module and a schema that
decodes it end to end. WebAssembly is a good showcase: every section length,
vector count, and index in the format is an LEB128 varint, so nothing sits at a
fixed offset.

```sh
# Decode a WASM module top to bottom
cargo run -p schema-runtime --example dump -- \
    demos/wasm/wasm.schema demos/wasm/module.wasm Module le
```

The headline is the **gzipped** copy — one field inflates the compressed stream
and parses the result inline:

```sh
cargo run -p schema-runtime --example dump -- \
    demos/wasm/wasm.schema demos/wasm/module.wasm.gz GzModule le
```

```
GzModule
  module: decode gunzip as Module        # spans the 73 compressed bytes
    magic: bytes[4] = 00 61 73 6d
    version: 1
    sections
      ...
        name: "add"                       # the export, pulled from inside the gzip
        body: 00 20 00 20 01 6a 0b        # the function's actual code
```

73 bytes of gzip become a full, structured module tree in a single step.

---

## Features

**Hex view**
- Virtualized rendering (only visible rows drawn; bytes paged from Rust) — opens
  multi-gigabyte files via memory mapping
- Offset gutter, ASCII pane, jump-to-offset, search
- Bidirectional highlight: click a field → its bytes light up, and vice versa
- Drag a byte range → pick a reading → it becomes a schema field (below)

**Schema language**
- `struct`, all fixed-width primitives (`u8`…`u64`, `i8`…`i64`, `f32`/`f64`,
  `bool`, `char`), `string[N]`, `bytes[N]`, `cstring`, `[*]` (rest of file)
- `enum` and `bitfield` with named flags and multi-bit ranges
- Arrays `T[N]` with fixed or field-driven lengths
- Pointers — read a field at an offset held elsewhere (`at`, `at +`)
- Conditional fields (`if`) and computed fields (arithmetic over earlier fields)
- Tag-dispatched unions — `match tag { 1 => Header  "PLYR" => Player }`
- Iteration — `repeat T until <cond>` for TLV / chunk / box formats, or a
  byte-pattern lookahead (`while 0x50 0x4b 0x01 0x02`) for the
  signature-terminated ones, which stops without consuming the terminator
- Inline transforms — `bytes[n] decode <t> [as <Type>]` for
  `xor` / `rolling_xor` / `add` / `base64` / `zlib` / `inflate` / `gunzip`
- Variable-length integers — `varint` / `svarint` (LEB128)
- Per-field byte order — `u32be` / `f64le` override the schema default, for the
  formats that mix the two
- Checksums — `check crc32 over(chunkType .. data)` validates a field against the
  bytes it covers (`crc32`, `crc16` and its Modbus / CCITT / XMODEM
  variants, `adler32`, `sum8/16/32`, `xor8`)

**Knowing what you don't know yet**
- Every parse reports how much of the file it actually explained, and the file
  map shades the runs no field accounts for — jump to the next one and drag it
  into a field
- Shape hints for a region you don't understand yet: repeating records and their
  stride, tables of offsets, string pools, padding. Each one states what it
  measured, so it reads as a lead rather than a verdict — and it is local
  arithmetic over the bytes, so nothing leaves your machine

**Editing & analysis**
- Edit bytes or typed field values in place, with undo/redo, then save
- Recompute stale checksums in one click, so an edited file still opens
- Diff against a second file: changed bytes marked in the hex view, changed
  fields shown as `old → new` in the parse tree
- Entropy strip, string extraction, format guessing
- Timestamp detection across the encodings that are actually used: Unix
  seconds and milliseconds, Windows FILETIME, MS-DOS packed dates
- Automatic format detection on open

**Formats & sharing**
- Built-in schemas for common formats (PNG, gzip, ELF, PE, Mach-O, ZIP,
  SQLite, PCAP)
- A plugin system for packaging and installing format definitions
- Browse and install community format packs from within the app

---

## Building a schema by hand

You don't have to know the language to start. Drag across a run of bytes in the
hex view and Nybble offers the readings those bytes actually support — with the
decoded value next to each, so you can see which one is right:

```
0xC–0x10 · 4 bytes                                   → struct PNG

  [ char[4]  "IHDR" ]  [ u32  1380206665 ]  [ bytes[4]  49 48 44 52 ]

  name: ihdr                                          [ Add field ]
```

Pick one, name it, and the field is appended to your schema and parsed
immediately — the node appears in the tree, its bytes light up, and you drag the
next run. A printable selection names itself (`IHDR` becomes `ihdr`), and any
unclaimed bytes before the selection become a `bytes[n]` pad so the new field
lands at its real offset.

The schema text accumulates in the editor as you go, so the format you're
reverse-engineering ends up as a file you can save, share, or publish to the
registry — and the language teaches itself on the way.

---

## A schema, end to end

```
struct Chunk {
    length    u32
    chunkType char[4]
    data      match chunkType {
        "IHDR"  => IhdrData
        default => bytes[length]
    }
    crc       u32 check crc32 over(chunkType .. data)
}

struct PNG {
    signature bytes[8]
    chunks    repeat Chunk until chunkType == "IEND"
}
```

Each field records its byte offset and size, so the UI can light up exactly the
bytes behind any node.

---

## Diffing two files

Two saves, two firmware revisions, a config before and after a settings change:
**Compare…** diffs the open file against another one, byte-aligned.

Changed bytes light up in the hex view (hover one to see what it used to be), and
the diff bar counts them and steps between regions. With a schema loaded, the
parse tree says what actually moved:

```
PLYR
  name: "Wren Ashgrave"
  level    27
  gold     41320 → 99999      # changed
  zone     4
```

That is the thing a plain hex differ cannot tell you — not just *which bytes*
changed, but *which field* they were.

Headless, for scripts:

```sh
nybble diff save_before.sav save_after.sav
```

---

## Checksums that fix themselves

Most binary formats carry a checksum, which means editing a payload normally
breaks the file. Describe the checksum once:

```
struct PngChunk {
    length    u32
    chunkType char[4]
    data      bytes[length]
    crc       u32 check crc32 over(chunkType .. data)
}
```

Nybble then validates it on every parse — a green tick when the file is intact,
and when it is not, the value it *should* hold. Edit a field, and one click
rewrites every stale checksum, so the file still opens in the tool that made it.

---

## On the command line

The app is for exploring one file. `nybble` is for the other half of the job:
running a finished schema over a hundred of them, diffing two captures in a
script, or asserting in CI that a format still parses.

```sh
nybble parse schemas/png.schema shot.png          # the field tree
nybble parse schemas/png.schema shot.png --json   # pipe it into jq
nybble diff before.sav after.sav                  # what changed
nybble detect firmware.bin                        # what is this?
nybble strings firmware.bin --min 6               # the readable text in it
nybble entropy firmware.bin                       # where is the packed data?
nybble hints firmware.bin --at 0x4000             # what shape are these bytes?
nybble check my.schema                            # does my schema compile?
```

A schema carries its own entry point and byte order in its `// @` header, so the
common case needs no flags. The exit status is what scripts want: **0** matched,
**1** did not (a parse fault, a failed checksum, a difference), **2** a usage
error. So this is a valid CI check:

```sh
nybble parse formats/firmware.schema build/out.bin --quiet || exit 1
```

A clean parse is not the same as a complete one — a `repeat` that stopped early
or a section the format grew will still read without a fault. `--min-coverage`
puts a floor under how much of the file the schema has to account for, so that
drift fails the build instead of passing quietly:

```sh
nybble parse formats/firmware.schema build/out.bin --min-coverage 99 --quiet
```

```sh
cargo run -p nybble-cli -- parse <schema> <file>   # without installing
```

---

## Install

Download the installer for your platform from the
[latest release](https://github.com/itsmajdbuilds/binary-explorer/releases/latest):

| Platform | File |
|---|---|
| Windows 10/11 | `Nybble_<version>_x64_en-US.msi` (or `_x64-setup.exe`) |
| macOS (Apple Silicon + Intel) | `Nybble_<version>_universal.dmg` |
| Linux | `Nybble_<version>_amd64.AppImage`, `.deb`, or `.rpm` |

### Unsigned builds

Nybble is not code-signed yet, so the OS will warn you the first time:

- **Windows** — SmartScreen shows "Windows protected your PC". Choose
  **More info -> Run anyway**.
- **macOS** — Gatekeeper refuses a double-click. **Right-click the app -> Open**,
  then confirm.
- **Linux** — no warning; mark the AppImage executable with `chmod +x`.

Signing certificates are a recurring cost that is hard to justify before a
project has users. Until then, verify what you downloaded instead.

### Verify your download

Every release ships a `SHA256SUMS.txt` generated by the CI job that built the
binaries. Compare your file against it:

```sh
# macOS / Linux
sha256sum -c SHA256SUMS.txt --ignore-missing
```

```powershell
# Windows
Get-FileHash .\Nybble_0.1.0_x64_en-US.msi -Algorithm SHA256
```

The strongest check is to skip the prebuilt binaries entirely and
[build from source](#build-from-source) — the full source is in this repository.

---

## Build from source

Prerequisites: a [Rust toolchain](https://rustup.rs), [Node.js](https://nodejs.org)
18+, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for
your platform.

```sh
npm install
npm run dev      # run the desktop app in development
npm run build    # produce a release installer
```

Run the engine headless (no UI) against any file:

```sh
cargo test                                   # full workspace test suite
cargo run -p nybble-cli -- parse <schema> <file>   # the CLI, without installing
cargo run -p schema-runtime --example dump -- <schema> <file> [entry] [le|be]
cargo run -p schema-parser  --example check -- <schema>   # validate a schema
```

---

## Layout

```
apps/desktop/        Tauri desktop app (React + TypeScript frontend, Rust backend)
crates/
  binary-reader/     endian-aware, memory-mapped byte reader
  schema/            the schema AST (pure data)
  schema-parser/     schema text -> AST
  schema-runtime/    execute a schema against bytes -> a field tree
  format-detection/  magic-byte format guessing
  analysis/          entropy, strings, timestamps
  search/            byte/string search
  diff/              aligned byte comparison of two files
  cli/               the `nybble` command-line binary
  file-editing/      in-place edits with undo/redo
  schema-library/    saved-schema storage
  plugin-host/       format-pack plugins
schemas/             built-in format schemas
demos/               runnable examples
```

---

## License

Nybble is dual-licensed:

- **[GNU AGPL v3](LICENSE)** — free for everyone. Use it, study it, modify it,
  fork it, and use it inside your organization at no cost. If you redistribute
  it or expose it over a network, share your source under the same terms.
- **[Commercial license](COMMERCIAL-LICENSE.md)** — for embedding Nybble in a
  closed-source product or hosted service without the AGPL's reciprocal
  obligations.

The files you analyze, and the schemas and format packs you write, are your own
work — the license covers Nybble itself, not its output.
