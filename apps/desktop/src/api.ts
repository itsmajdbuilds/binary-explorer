// Typed wrappers around the Tauri IPC commands exposed by the Rust backend.
// The UI only ever talks to the file through these functions (see the
// architecture principle: the UI does not know how bytes are read from disk).
import { invoke } from "@tauri-apps/api/core";

export interface FileInfo {
  path: string;
  name: string;
  len: number;
}

interface ByteWindow {
  offset: number;
  len: number;
  base64: string;
}

export interface Interpretations {
  offset: number;
  u8: number | null;
  i8: number | null;
  u16_le: number | null;
  u16_be: number | null;
  u32_le: number | null;
  u32_be: number | null;
  u64_le: number | null;
  u64_be: number | null;
  i32_le: number | null;
  i32_be: number | null;
  f32_le: number | null;
  f32_be: number | null;
  f64_le: number | null;
  f64_be: number | null;
}

export function openFile(path: string): Promise<FileInfo> {
  return invoke<FileInfo>("open_file", { path });
}

export function getFileInfo(): Promise<FileInfo | null> {
  return invoke<FileInfo | null>("get_file_info");
}

export async function readRange(offset: number, length: number): Promise<Uint8Array> {
  const w = await invoke<ByteWindow>("read_range", { offset, length });
  return base64ToBytes(w.base64);
}

export function interpret(offset: number): Promise<Interpretations> {
  return invoke<Interpretations>("interpret", { offset });
}

// --- Schema runtime (Phases 3-5) -------------------------------------------

/** A decoded scalar value. Mirrors the Rust `schema_runtime::Value` enum,
 *  which serializes as `{ kind, value }` (unit variants omit `value`). */
export type Value =
  | { kind: "u"; value: number }
  | { kind: "i"; value: number }
  | { kind: "f"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "char"; value: string }
  | { kind: "str"; value: string }
  | { kind: "bytes"; value: number[] }
  | { kind: "struct" }
  | { kind: "array" }
  | { kind: "enum"; value: { value: number; name: string | null } }
  | { kind: "bitfield" };

/** The verdict of a schema `check` clause. Mirrors `schema_runtime::CheckResult`.
 *  A mismatch is not a parse error — the bytes decoded, the file is just no
 *  longer self-consistent, and `computed` is the value that would fix it. */
export interface CheckResult {
  /** Algorithm as written in the schema, e.g. "crc32". */
  algo: string;
  /** What the covered bytes produce now. */
  computed: number;
  /** What the file stores in this field. */
  stored: number;
  ok: boolean;
  /** The byte span the checksum covers. */
  over_offset: number;
  over_size: number;
}

/** A node in the parsed structure tree. Mirrors `schema_runtime::FieldNode`. */
export interface FieldNode {
  name: string;
  type_name: string;
  value: Value;
  offset: number;
  size: number;
  description: string;
  /** Present only on fields carrying a `check` clause. */
  check?: CheckResult;
  /** True when this node's children were parsed out of decoded bytes, so their
   *  offsets index that buffer rather than the file. */
  decoded?: boolean;
  children: FieldNode[];
}

/** What kind of wall a parse hit. Mirrors `schema_runtime::FaultKind`. */
export type FaultKind = "out_of_bounds" | "schema" | "data" | "limit";

/** Where and why schema execution stopped. Mirrors `schema_runtime::Fault`. */
export interface Fault {
  /** The runtime error, rendered. */
  message: string;
  kind: FaultKind;
  /** Offset parsing stopped at - in the file, unless `decoded` is set. */
  offset: number;
  /** Root-to-node field path, e.g. `Png.chunks[3].length`. */
  path: string;
  /** 1-based line in the schema source that declared the failing field. */
  schema_line?: number;
  /** True when `offset` indexes a decoded buffer rather than the file, so it
   *  must not be used to jump the hex view. */
  decoded: boolean;
}

/** A byte range. Mirrors `schema_runtime::coverage::Span`. */
export interface CoverageSpan {
  offset: number;
  len: number;
}

/** How much of the file a parse accounted for. Mirrors `schema_runtime::Coverage`.
 *  Only fields that read bytes themselves count, so a hole between two fields
 *  shows up rather than being hidden by the struct that spans it. */
export interface Coverage {
  total: number;
  covered: number;
  /** Runs of bytes no field claims, ascending. */
  gaps: CoverageSpan[];
  /** True when the gap list hit its cap; `covered` is still exact. */
  truncated: boolean;
}

/** A parse result: whatever decoded, plus the fault that stopped it (if any).
 *  Mirrors `schema_runtime::ParseOutcome`. */
export interface ParseOutcome {
  tree: FieldNode;
  fault?: Fault;
  coverage: Coverage;
}

/** A detected file format. Mirrors the backend `DetectionOut`. */
export interface Detection {
  format: string;
  extension: string;
  description: string;
  confidence: number;
  /** Whether a built-in signature or an installed plugin recognized it. */
  source?: "builtin" | "plugin";
}

/** Detect known formats from the open file's header (magic numbers). */
export function detectFormat(): Promise<Detection[]> {
  return invoke<Detection[]>("detect_format");
}

// --- Analysis heuristics (Phase 8) -----------------------------------------

/** A readable string found by the scanner. Mirrors `analysis::StringHit`. */
export interface StringHit {
  offset: number;
  len: number;
  encoding: "ascii" | "utf16_le" | "utf16_be";
  text: string;
}

/** A semantic guess about the bytes at an offset. Mirrors `analysis::Guess`. */
export interface Guess {
  label: string;
  detail: string;
}

/** Scan the start of the file for readable strings (>= minLen chars). */
export function findStrings(minLen: number): Promise<StringHit[]> {
  return invoke<StringHit[]>("find_strings", { minLen });
}

/** Ask what the bytes at `offset` could be (string, timestamp, UUID, …). */
export function analyzeAt(offset: number): Promise<Guess[]> {
  return invoke<Guess[]>("analyze_at", { offset });
}

/** An observation about the shape of a region. Mirrors `analysis::Hint`. */
export interface Hint {
  /** Short kind, e.g. "records", "offset table". */
  label: string;
  /** What was measured, in words — the evidence, not just the verdict. */
  detail: string;
  offset: number;
  len: number;
}

/** What the shape scan examined and found. Mirrors Rust `StructureHints`. */
export interface StructureHints {
  offset: number;
  len: number;
  /** True when the requested region was larger than the scan cap. */
  clamped: boolean;
  hints: Hint[];
}

/** Guess the shape of a region: repeating records, an offset table, a string
 *  pool, padding. Runs locally over the open file's bytes. */
export function inferStructure(offset: number, length: number): Promise<StructureHints> {
  return invoke<StructureHints>("infer_structure", { offset, length });
}

/** Byte entropy across the whole file, as `buckets` values in [0,1]. */
export function entropy(buckets: number): Promise<number[]> {
  return invoke<number[]>("entropy", { buckets });
}

/** A ready-made schema for a recognized format. Mirrors `BuiltinSchema`. */
export interface BuiltinSchema {
  text: string;
  entry: string;
  endian: Endianness;
}

/** Fetch the built-in schema for a detected format, or null if none. */
export function builtinSchema(format: string): Promise<BuiltinSchema | null> {
  return invoke<BuiltinSchema | null>("builtin_schema", { format });
}

export type SearchKind = "hex" | "text" | "utf16" | "value";

/** Search the open file for a pattern; returns match offsets. For the `value`
 *  kind, pass the integer `width` in bytes (1/2/4/8) and the `endian`. */
export function search(
  kind: SearchKind,
  query: string,
  width?: number,
  endian?: Endianness,
): Promise<number[]> {
  return invoke<number[]>("search", { kind, query, width: width ?? null, endian: endian ?? null });
}

/** Write schema text to a file on disk. */
export function saveSchema(path: string, text: string): Promise<void> {
  return invoke<void>("save_schema", { path, text });
}

/** Read schema text from a file on disk. */
export function loadSchema(path: string): Promise<string> {
  return invoke<string>("load_schema", { path });
}

export type Endianness = "le" | "be";

/** Parse `schemaText` and execute it against the open file. `entry` may be
 *  empty to use the schema's first struct. */
export function parseSchema(
  schemaText: string,
  entry: string,
  endian: Endianness,
): Promise<ParseOutcome> {
  return invoke<ParseOutcome>("parse_schema", { schemaText, entry, endian });
}

// --- Editing (Phase 10) ----------------------------------------------------

/** Edit-buffer state. Mirrors the Rust `EditStatus`. */
export interface EditStatus {
  dirty: boolean;
  dirty_count: number;
  can_undo: boolean;
  can_redo: boolean;
  dirty_offsets: number[];
}

/** The `Value` tags the backend can encode back into bytes. */
export type EditableKind = "u" | "i" | "f" | "bool" | "char" | "str" | "bytes";

/** Whether a decoded value can be edited in place (scalars, not struct/array). */
export function isEditableKind(kind: Value["kind"]): kind is EditableKind {
  return kind === "u" || kind === "i" || kind === "f" || kind === "bool" ||
    kind === "char" || kind === "str" || kind === "bytes";
}

/** Current edit-buffer status (dirty flag, undo/redo, edited offsets). */
export function editStatus(): Promise<EditStatus> {
  return invoke<EditStatus>("edit_status");
}

/** Overwrite raw bytes at `offset` as one undoable edit. */
export function setBytes(offset: number, bytes: Uint8Array): Promise<EditStatus> {
  return invoke<EditStatus>("set_bytes", { offset, dataBase64: bytesToBase64(bytes) });
}

/** Encode a typed value and overwrite the field at `offset`. */
export function setFieldValue(
  offset: number,
  size: number,
  kind: EditableKind,
  endian: Endianness,
  value: string,
): Promise<EditStatus> {
  return invoke<EditStatus>("set_field_value", { offset, size, kind, endian, value });
}

export function undoEdit(): Promise<EditStatus> {
  return invoke<EditStatus>("undo_edit");
}

export function redoEdit(): Promise<EditStatus> {
  return invoke<EditStatus>("redo_edit");
}

export function revertEdits(): Promise<EditStatus> {
  return invoke<EditStatus>("revert_edits");
}

/** Result of a checksum repair pass. Mirrors the Rust `FixOutcome`. */
export interface FixOutcome {
  /** How many checksum fields were rewritten. */
  fixed: number;
  /** How many still disagree with their bytes afterwards. */
  remaining: number;
  status: EditStatus;
}

/** Rewrite every mismatching `check` field with the checksum its bytes produce,
 *  as pending (undoable) edits. */
export function fixChecksums(
  schemaText: string,
  entry: string,
  endian: Endianness,
): Promise<FixOutcome> {
  return invoke<FixOutcome>("fix_checksums", { schemaText, entry, endian });
}

/** Save pending edits in place (backs up the original to `<path>.bak`). */
export function saveFile(): Promise<FileInfo> {
  return invoke<FileInfo>("save_file");
}

/** Save the edited bytes to a new path and switch to editing it. */
export function saveFileAs(path: string): Promise<FileInfo> {
  return invoke<FileInfo>("save_file_as", { path });
}

// --- Schema library & sharing (Phase 12) -----------------------------------

/** An entry in the schema library. Mirrors the Rust `SchemaEntry`. */
export interface SchemaEntry {
  id: string;
  name: string;
  entry: string;
  endian: Endianness;
  description: string;
  source: "builtin" | "user" | "plugin";
}

/** A schema loaded for the editor. Mirrors the Rust `LoadedSchema`. */
export interface LoadedSchema {
  text: string;
  name: string;
  entry: string;
  endian: Endianness;
  description: string;
}

/** List all available schemas: bundled ones plus the user's saved library. */
export function libraryList(): Promise<SchemaEntry[]> {
  return invoke<SchemaEntry[]>("library_list");
}

/** Load a schema from the library by id. */
export function libraryLoad(id: string): Promise<LoadedSchema> {
  return invoke<LoadedSchema>("library_load", { id });
}

/** Save the current schema into the user's library. */
export function libraryAdd(
  name: string,
  entry: string,
  endian: Endianness,
  description: string,
  text: string,
): Promise<SchemaEntry> {
  return invoke<SchemaEntry>("library_add", { name, entry, endian, description, text });
}

/** Remove a user schema from the library. */
export function libraryRemove(id: string): Promise<void> {
  return invoke<void>("library_remove", { id });
}

/** Write the current schema (with metadata) to a path, for sharing. */
export function exportSchema(
  path: string,
  name: string,
  entry: string,
  endian: Endianness,
  description: string,
  text: string,
): Promise<void> {
  return invoke<void>("export_schema", { path, name, entry, endian, description, text });
}

/** Read a shared schema file, returning its text and metadata. */
export function importSchema(path: string): Promise<LoadedSchema> {
  return invoke<LoadedSchema>("import_schema", { path });
}

/** Fields for exporting the current schema as a registry plugin pack. */
export interface PluginPack {
  path: string;
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  formatName: string;
  extension: string;
  entry: string;
  endian: Endianness;
  confidence: number;
  detectOffset: number;
  detectHex: string;
  schemaText: string;
}

/** Write the current schema as a registry-ready `plugin.toml`. Validates that
 *  the schema parses before writing, so the pack is guaranteed installable. */
export function exportPlugin(pack: PluginPack): Promise<void> {
  return invoke<void>("export_plugin", pack as unknown as Record<string, unknown>);
}

// --- Format plugins (plan §18, Phase A) ------------------------------------

/** One format a plugin contributes. Mirrors the Rust `PluginFormatInfo`. */
export interface PluginFormatInfo {
  name: string;
  extension: string;
  description: string;
  confidence: number;
  /** Whether this format auto-detects (has a magic-number rule). */
  detects: boolean;
}

/** An installed plugin. Mirrors the Rust `PluginInfo`. `error` is set for a
 *  plugin file that failed to parse. */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  enabled: boolean;
  file: string;
  formats: PluginFormatInfo[];
  error: string | null;
}

/** List installed format plugins. */
export function pluginList(): Promise<PluginInfo[]> {
  return invoke<PluginInfo[]>("plugin_list");
}

/** Install a plugin from a `.toml` file on disk. Validates it first. */
export function pluginInstall(path: string): Promise<PluginInfo> {
  return invoke<PluginInfo>("plugin_install", { path });
}

/** Remove an installed plugin by its file name (works for broken ones too). */
export function pluginRemove(file: string): Promise<void> {
  return invoke<void>("plugin_remove", { file });
}

/** Enable or disable an installed plugin. */
export function pluginSetEnabled(id: string, enabled: boolean): Promise<void> {
  return invoke<void>("plugin_set_enabled", { id, enabled });
}

// --- Format registry (Phase 2 — browse & install shared packs) -------------

/** One format contributed by a registry entry. Mirrors Rust `RegistryFormat`. */
export interface RegistryFormat {
  name: string;
  extension: string;
  detects: boolean;
  confidence: number;
}

/** A pack listed in the registry's index.json. Mirrors Rust `RegistryEntry`. */
export interface RegistryEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  category: string;
  tags: string[];
  formats: RegistryFormat[];
  /** Repo-relative path to the installable plugin.toml (used by install). */
  path: string;
}

/** The registry catalog. Mirrors Rust `RegistryCatalog`. */
export interface RegistryCatalog {
  version: number;
  count: number;
  formats: RegistryEntry[];
}

/** Fetch the online registry catalog (index.json). Requires network. */
export function registryCatalog(): Promise<RegistryCatalog> {
  return invoke<RegistryCatalog>("registry_catalog");
}

/** Download a registry pack by its index `path` and install it locally. */
export function registryInstall(path: string): Promise<PluginInfo> {
  return invoke<PluginInfo>("registry_install", { path });
}

/** A registry pack whose signature matches the open file. Mirrors Rust `RegistrySuggestion`. */
export interface RegistrySuggestion {
  id: string;
  /** Pass to `registryInstall`. */
  path: string;
  name: string;
  description: string;
  /** The matching format within the pack, as `builtinSchema` takes it once installed. */
  format: string;
  extension: string;
  confidence: number;
}

/** Mirrors Rust `RegistrySuggestions`. */
export interface RegistrySuggestions {
  /** False when no registry index has been downloaded yet, so nothing was checked. */
  checked: boolean;
  matches: RegistrySuggestion[];
}

/** Match the open file against every registry pack not yet installed. Offline
 *  unless `refresh`: it uses the index saved by the last browse or check. Only
 *  the public index is ever downloaded; the file's bytes stay local. */
export function registrySuggest(refresh: boolean): Promise<RegistrySuggestions> {
  return invoke<RegistrySuggestions>("registry_suggest", { refresh });
}

// --- Compare against another file ------------------------------------------

/** Summary of an active comparison. Mirrors the Rust `CompareStatus`. */
export interface CompareStatus {
  path: string;
  name: string;
  /** Length of the open file, and of the one it is compared against. */
  a_len: number;
  b_len: number;
  /** Differing bytes within the length the two files share. */
  changed_bytes: number;
  /** How many separate regions those bytes form. */
  region_count: number;
  /** True when the region list hit its cap; the counts are still exact. */
  truncated: boolean;
  identical: boolean;
  /** Start of the first changed region, for "jump to the first change". */
  first_change: number | null;
}

/** Compare the open file against another one and keep the diff active. */
export function compareOpen(path: string): Promise<CompareStatus> {
  return invoke<CompareStatus>("compare_open", { path });
}

/** Drop the active comparison. */
export function compareClose(): Promise<void> {
  return invoke<void>("compare_close");
}

/** Summary of the active comparison, or null if none. */
export function compareStatus(): Promise<CompareStatus | null> {
  return invoke<CompareStatus | null>("compare_status");
}

/** Recompute the diff after the open file's bytes changed (an edit, a save). */
export function compareRefresh(): Promise<CompareStatus | null> {
  return invoke<CompareStatus | null>("compare_refresh");
}

/** Read a window of bytes from the file being compared against. */
export async function compareRead(offset: number, length: number): Promise<Uint8Array> {
  const w = await invoke<ByteWindow>("compare_read", { offset, length });
  return base64ToBytes(w.base64);
}

/** Start of the next changed region after `from` (or the previous one). */
export function compareSeek(from: number, forward: boolean): Promise<number | null> {
  return invoke<number | null>("compare_seek", { from, forward });
}

/** Run the current schema against the compared file, for old -> new values. */
export function compareParse(
  schemaText: string,
  entry: string,
  endian: Endianness,
): Promise<ParseOutcome> {
  return invoke<ParseOutcome>("compare_parse", { schemaText, entry, endian });
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
