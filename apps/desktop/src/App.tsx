import { useEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  openFile,
  interpret,
  readRange,
  parseSchema,
  detectFormat,
  findStrings,
  analyzeAt,
  entropy,
  inferStructure,
  search,
  builtinSchema,
  setFieldValue,
  undoEdit,
  redoEdit,
  revertEdits,
  saveFile,
  saveFileAs,
  editStatus,
  isEditableKind,
  libraryList,
  libraryLoad,
  libraryAdd,
  libraryRemove,
  exportSchema,
  importSchema,
  compareOpen,
  compareClose,
  compareRefresh,
  compareSeek,
  compareParse,
  fixChecksums,
  registryInstall,
  registrySuggest,
  type CompareStatus,
  type Coverage,
  type SchemaEntry,
  type SearchKind,
  type BuiltinSchema,
  type Detection,
  type Endianness,
  type EditStatus,
  type Fault,
  type FieldNode,
  type FileInfo,
  type Interpretations,
  type StringHit,
  type Guess,
  type StructureHints,
  type RegistrySuggestions,
  type RegistrySuggestion,
} from "./api";
import { HexView } from "./HexView";
import { FieldBuilder, PREVIEW_CAP } from "./FieldBuilder";
import { insertFields, targetStructName } from "./schemaEdit";
import { FileMap } from "./FileMap";
import { SchemaEditor } from "./SchemaEditor";
import { Plugins } from "./Plugins";
import { ExportPack } from "./ExportPack";
import {
  broadcastSnapshot,
  onRequest,
  onAction,
  PANEL_TITLES,
  type PanelAction,
  type PanelId,
  type UiSnapshot,
} from "./panelSync";
import { StructureTree, countBadChecks, findFieldAtOffset } from "./StructureTree";
import { ValueInspector } from "./ValueInspector";
import { DataPreview } from "./DataPreview";
import { EntropyStrip } from "./EntropyStrip";
import { buildColorMap, colorAt as colorAtRange } from "./colors";

type Range = { start: number; end: number };

const SAMPLE_SCHEMA = `struct Header {
    magic   char[4]  "file magic"
    version u16      "schema revision"
    flags   u16      "bit flags"
    size    u32      "total size in bytes"
}`;

export function App() {
  const [file, setFile] = useState<FileInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [interp, setInterp] = useState<Interpretations | null>(null);
  const [gotoText, setGotoText] = useState("");
  const [formats, setFormats] = useState<Detection[]>([]);
  const [builtin, setBuiltin] = useState<BuiltinSchema | null>(null);
  /** Registry packs that would read the open file, offered when no installed
   *  schema can. Null hides the bar (a schema is available, or it was dismissed). */
  const [suggest, setSuggest] = useState<RegistrySuggestions | null>(null);
  const [suggestBusy, setSuggestBusy] = useState(false);
  const [entropyData, setEntropyData] = useState<number[]>([]);
  const [viewMode, setViewMode] = useState<"hex" | "text">("hex");
  const [strings, setStrings] = useState<StringHit[]>([]);
  /** What the bytes look like in the large: records, tables, pools, padding.
   *  Scoped to the dragged selection when there is one, else the whole file. */
  const [shape, setShape] = useState<StructureHints | null>(null);
  const [guesses, setGuesses] = useState<Guess[]>([]);

  // Search
  const [searchKind, setSearchKind] = useState<SearchKind>("text");
  const [searchQuery, setSearchQuery] = useState("");
  const [valueWidth, setValueWidth] = useState(4); // bytes, for typed value search
  const [matches, setMatches] = useState<number[]>([]);
  const [matchIndex, setMatchIndex] = useState(0);
  const [matchLen, setMatchLen] = useState(0);

  // Schema / structure. Last-used schema is remembered across restarts.
  const [schemaText, setSchemaText] = useState(() => localStorage.getItem("schemaText") ?? SAMPLE_SCHEMA);
  const [entry, setEntry] = useState(() => localStorage.getItem("schemaEntry") ?? "");
  const [endian, setEndian] = useState<Endianness>(
    () => (localStorage.getItem("schemaEndian") as Endianness) ?? "le",
  );
  const [tree, setTree] = useState<FieldNode | null>(null);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  /** Where a partial parse stopped. The tree is still shown alongside it. */
  const [fault, setFault] = useState<Fault | null>(null);
  /** What the schema accounted for, and which bytes it left unexplained. */
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<Range | null>(null);
  const [selectedNode, setSelectedNode] = useState<FieldNode | null>(null);
  const [rawBytes, setRawBytes] = useState<Uint8Array | null>(null);

  // A byte range dragged in the hex view, and its bytes — the raw material for
  // the field builder ("make this a field").
  const [selection, setSelection] = useState<Range | null>(null);
  const [selBytes, setSelBytes] = useState<Uint8Array | null>(null);
  // True while the pointer is still down. The range highlights live, but the
  // field builder only opens once the drag ends.
  const [dragging, setDragging] = useState(false);

  // Comparison against a second file. `otherTree` is the same schema run against
  // it, which is what lets the tree show `was -> is` per field.
  const [compare, setCompare] = useState<CompareStatus | null>(null);
  const [otherTree, setOtherTree] = useState<FieldNode | null>(null);
  /** Bumped whenever the comparison changes, so the hex view drops its cached
   *  pages of the other file. */
  const [compareVersion, setCompareVersion] = useState(0);
  // Kept stable so the hex view's fetch effect doesn't re-run every render.
  const hexCompare = useMemo(
    () => (compare ? { bLen: compare.b_len } : null),
    [compare],
  );

  // Schema library (Phase 12).
  const [library, setLibrary] = useState<SchemaEntry[]>([]);
  const [showPlugins, setShowPlugins] = useState(false);
  const [showPack, setShowPack] = useState(false);
  const [packNotice, setPackNotice] = useState<string | null>(null);
  // Resizable workspace columns (px). The hex column (3rd) is the flexible
  // filler; these three are drag-adjustable and persisted.
  const [colW, setColW] = useState<{ tree: number; vinspect: number; right: number }>(() => {
    const s = localStorage.getItem("colW");
    if (s) {
      try {
        const v = JSON.parse(s);
        if (v && typeof v.tree === "number") return v;
      } catch { /* fall through to defaults */ }
    }
    return { tree: 230, vinspect: 250, right: 340 };
  });
  useEffect(() => {
    localStorage.setItem("colW", JSON.stringify(colW));
  }, [colW]);
  const [savingLib, setSavingLib] = useState(false);
  const [libName, setLibName] = useState("");
  const [libDesc, setLibDesc] = useState("");

  // Editing (Phase 10). `editVersion` bumps after every edit so the hex view
  // re-fetches its byte pages; `edit` carries the dirty flag and edited offsets.
  const [edit, setEdit] = useState<EditStatus | null>(null);
  const [editVersion, setEditVersion] = useState(0);
  const dirtySet = useMemo(() => new Set(edit?.dirty_offsets ?? []), [edit]);
  const isEdited = (offset: number) => dirtySet.has(offset);

  // Checksum fields whose value no longer matches the bytes they cover — the
  // normal state after editing a payload, and the cue to offer a repair.
  const badChecks = useMemo(() => (tree ? countBadChecks(tree) : 0), [tree]);

  // Field colors, shared by the hex view and the parse tree.
  const colorMap = useMemo(() => buildColorMap(tree), [tree]);
  const colorFor = (offset: number) => colorAtRange(colorMap, offset);

  // --- Pop-out panel sync. The main window is the source of truth: it
  // broadcasts a UI snapshot on change, answers a new panel's request for the
  // current one, and applies selection actions panels send back. ------------
  const snapRef = useRef<UiSnapshot | null>(null);
  useEffect(() => {
    const snap: UiSnapshot = {
      filePath: file?.path ?? null,
      fileLen: file?.len ?? 0,
      selected,
      highlight,
      selection,
      endian,
      viewMode,
      schemaText,
      entry,
      schemaError,
      fault,
      editVersion,
      compare: compare ? { name: compare.name, bLen: compare.b_len } : null,
      compareVersion,
    };
    snapRef.current = snap;
    broadcastSnapshot(snap);
  }, [file, selected, highlight, selection, endian, viewMode, schemaText, entry, schemaError, fault, editVersion, compare, compareVersion]);

  // Apply an action sent up by a pop-out panel. Held in a ref because the
  // listener below is registered once on mount: schema/entry edits and
  // re-parse need the *current* state, not the state as of mount.
  const applyAction = (a: PanelAction) => {
    switch (a.type) {
      case "select":
        selectByte(a.offset);
        break;
      case "selrange":
        pickRange(a.range, a.done);
        break;
      case "schema":
        setSchemaText(a.text);
        break;
      case "entry":
        setEntry(a.value);
        break;
      case "parse":
        void handleParse();
        break;
    }
  };
  const actionRef = useRef(applyAction);
  actionRef.current = applyAction;

  useEffect(() => {
    let alive = true;
    const uns: Array<() => void> = [];
    const track = (p: Promise<() => void>) =>
      p.then((u) => (alive ? uns.push(u) : u()));
    track(onRequest(() => snapRef.current && broadcastSnapshot(snapRef.current)));
    track(onAction((a) => actionRef.current(a)));
    return () => {
      alive = false;
      uns.forEach((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Open a panel in its own OS window (or focus it if already open). */
  async function popOut(panel: PanelId) {
    const label = `panel-${panel}`;
    try {
      const existing = await WebviewWindow.getByLabel(label);
      if (existing) {
        await existing.setFocus();
        return;
      }
    } catch {
      /* not open yet — create it */
    }
    const size = panel === "schema" ? { width: 680, height: 760 } : { width: 480, height: 640 };
    const w = new WebviewWindow(label, {
      url: `index.html?panel=${panel}`,
      title: `Nybble — ${PANEL_TITLES[panel]}`,
      ...size,
    });
    w.once("tauri://error", (e) =>
      setError(`Could not open panel window: ${JSON.stringify(e.payload)}`),
    );
  }

  async function handleOpen() {
    setError(null);
    try {
      const path = await open({ multiple: false, directory: false });
      if (typeof path !== "string") return; // cancelled
      const info = await openFile(path);
      setFile(info);
      setSelected(null);
      setInterp(null);
      setTree(null);
      setFault(null);
      setCoverage(null);
      setActivePath(null);
      setHighlight(null);
      setSelectedNode(null);
      setRawBytes(null);
      setSelection(null);
      setDragging(false);
      setCompare(null);
      setOtherTree(null);
      setCompareVersion((v) => v + 1);
      setGuesses([]);
      setMatches([]);
      setMatchIndex(0);
      setEdit(null);
      setEditVersion((v) => v + 1);
      await detectAndSuggest();
      setStrings(await findStrings(4));
      setEntropyData(await entropy(256));
      setShape(null);
    } catch (e) {
      setError(String(e));
    }
  }

  // Recognise the open file. When nothing installed has a schema for it, look
  // for a registry pack that does — offline, against the last saved index.
  async function detectAndSuggest() {
    const detected = await detectFormat();
    setFormats(detected);
    const schema = detected.length > 0 ? await builtinSchema(detected[0].format) : null;
    setBuiltin(schema);
    if (schema) {
      setSuggest(null);
      return;
    }
    try {
      // A miss against the saved index stays quiet; "no match" is only said
      // after the user asks for a fresh check.
      const found = await registrySuggest(false);
      setSuggest(found.checked && found.matches.length === 0 ? null : found);
    } catch {
      setSuggest(null);
    }
  }

  // The user asked: download the current registry index and match again.
  async function handleCheckRegistry() {
    setSuggestBusy(true);
    try {
      setSuggest(await registrySuggest(true));
    } catch (e) {
      setError(String(e));
    } finally {
      setSuggestBusy(false);
    }
  }

  // Install the suggested pack, then load its schema straight onto the file.
  async function handleInstallSuggested(s: RegistrySuggestion) {
    setSuggestBusy(true);
    try {
      await registryInstall(s.path);
      await handlePluginsChanged();
      const schema = await builtinSchema(s.format);
      if (schema) {
        setSchemaText(schema.text);
        setEntry(schema.entry);
        setEndian(schema.endian);
        await runParse(schema.text, schema.entry, schema.endian);
      }
      setSuggest(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setSuggestBusy(false);
    }
  }

  // After plugins change, re-detect the open file and refresh the library so
  // any newly available formats/schemas show up immediately.
  async function handlePluginsChanged() {
    try {
      setLibrary(await libraryList());
    } catch {
      /* leave the current library on failure */
    }
    if (file) {
      try {
        await detectAndSuggest();
      } catch (e) {
        setError(String(e));
      }
    }
  }

  // Selected byte -> byte interpretations + semantic guesses.
  useEffect(() => {
    if (selected == null) {
      setInterp(null);
      setGuesses([]);
      return;
    }
    interpret(selected).then(setInterp).catch((e) => setError(String(e)));
    analyzeAt(selected).then(setGuesses).catch(() => setGuesses([]));
  }, [selected]);

  // Selected field -> fetch its raw bytes for the value inspector.
  useEffect(() => {
    if (!selectedNode || selectedNode.size === 0) {
      setRawBytes(null);
      return;
    }
    const n = Math.min(selectedNode.size, 32);
    readRange(selectedNode.offset, n).then(setRawBytes).catch(() => setRawBytes(null));
  }, [selectedNode]);

  /** Track a hex-view range: live while dragging, settled when `done`. */
  function pickRange(range: Range | null, done: boolean) {
    setSelection(range);
    setDragging(!done);
  }

  // Selected range -> its bytes, for the field builder's candidate readings.
  // Long selections only fetch a head: no reading needs more than that.
  useEffect(() => {
    if (selection == null || dragging) {
      setSelBytes(null);
      return;
    }
    const n = Math.min(selection.end - selection.start, PREVIEW_CAP);
    let alive = true;
    readRange(selection.start, n)
      .then((b) => alive && setSelBytes(b))
      .catch(() => alive && setSelBytes(null));
    return () => {
      alive = false;
    };
  }, [selection, dragging, editVersion]);

  // Shape hints follow the focus: a settled drag asks about that region, and
  // with nothing selected the question is about the file as a whole.
  useEffect(() => {
    if (!file) {
      setShape(null);
      return;
    }
    const region =
      selection && !dragging
        ? { offset: selection.start, length: selection.end - selection.start }
        : { offset: 0, length: file.len };
    let alive = true;
    inferStructure(region.offset, region.length)
      .then((s) => alive && setShape(s))
      .catch(() => alive && setShape(null));
    return () => {
      alive = false;
    };
  }, [file, selection, dragging, editVersion]);

  // Persist schema settings.
  useEffect(() => {
    localStorage.setItem("schemaText", schemaText);
    localStorage.setItem("schemaEntry", entry);
    localStorage.setItem("schemaEndian", endian);
  }, [schemaText, entry, endian]);

  // Re-link a fresh tree to the current byte selection.
  useEffect(() => {
    if (tree == null || selected == null) return;
    const found = findFieldAtOffset(tree, selected);
    setActivePath(found?.path ?? null);
    setSelectedNode(found?.node ?? null);
    setHighlight(found ? { start: found.node.offset, end: found.node.offset + found.node.size } : null);
  }, [tree]);

  // --- Selection -> schema field --------------------------------------------

  /** Bytes the current parse already covers; a new field is appended after it. */
  const parsedEnd = tree ? tree.offset + tree.size : 0;
  const gap = selection ? Math.max(0, selection.start - parsedEnd) : 0;
  const overlaps = selection != null && selection.start < parsedEnd;

  /**
   * Append the selected range to the schema as a field, then re-parse so the
   * new node shows up in the tree immediately. `pad` bytes of unclaimed space
   * before it become a filler field, so the new one lands at its real offset.
   */
  async function addSelectionField(name: string, type: string, pad: number) {
    if (!selection) return;
    const fields = pad > 0
      ? [{ name: `pad_${parsedEnd.toString(16)}`, type: `bytes[${pad}]` }, { name, type }]
      : [{ name, type }];
    const next = insertFields(schemaText, entry, fields);
    const start = selection.start;
    setSchemaText(next);
    setSelection(null);
    setSelected(start);
    await runParse(next, entry, endian);
  }

  function handleGoto(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    const raw = gotoText.trim().replace(/^0x/i, "");
    const offset = parseInt(raw, 16);
    if (Number.isNaN(offset) || offset < 0 || offset >= file.len) {
      setError(`Offset out of range (0 .. 0x${(file.len - 1).toString(16)})`);
      return;
    }
    setError(null);
    selectByte(offset);
  }

  function needleLen(kind: SearchKind, query: string): number {
    if (kind === "hex") return query.replace(/\s/g, "").length / 2;
    if (kind === "utf16") return query.length * 2;
    if (kind === "value") return valueWidth;
    return new TextEncoder().encode(query).length;
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!file || searchQuery === "") return;
    try {
      const hits =
        searchKind === "value"
          ? await search("value", searchQuery, valueWidth, endian)
          : await search(searchKind, searchQuery);
      setMatches(hits);
      setMatchIndex(0);
      const len = needleLen(searchKind, searchQuery);
      setMatchLen(len);
      if (hits.length > 0) jumpToMatch(hits[0], len);
      else setError(`No matches for ${searchKind} "${searchQuery}"`);
    } catch (err) {
      setError(String(err));
    }
  }

  function stepMatch(delta: number) {
    if (matches.length === 0) return;
    const next = (matchIndex + delta + matches.length) % matches.length;
    setMatchIndex(next);
    jumpToMatch(matches[next], matchLen);
  }

  function jumpToMatch(offset: number, len: number) {
    setSelected(offset);
    setHighlight({ start: offset, end: offset + len });
  }

  /**
   * Run a schema and take whatever it produced.
   *
   * A parse that hits a bad field still returns the fields that decoded, so the
   * tree is kept and the fault is shown beside it - being wrong while authoring
   * should cost you the rest of the parse, not the whole view. `catch` is now
   * only for a schema that does not compile at all.
   */
  async function runParse(text: string, ent: string, end: Endianness) {
    try {
      const out = await parseSchema(text, ent, end);
      setTree(out.tree);
      setFault(out.fault ?? null);
      setCoverage(out.coverage ?? null);
      setSchemaError(null);
    } catch (e) {
      setTree(null);
      setFault(null);
      setCoverage(null);
      setActivePath(null);
      setHighlight(null);
      setSelectedNode(null);
      setSchemaError(String(e));
    }
  }

  async function handleParse() {
    if (!file) return;
    await runParse(schemaText, entry, endian);
  }

  async function handleUseBuiltin() {
    if (!builtin) return;
    setSchemaText(builtin.text);
    setEntry(builtin.entry);
    setEndian(builtin.endian);
    await runParse(builtin.text, builtin.entry, builtin.endian);
  }

  // --- Schema library & sharing (Phase 12) ----------------------------------

  // Load the library (bundled + user schemas) once on startup.
  useEffect(() => {
    libraryList().then(setLibrary).catch(() => {});
  }, []);

  // Apply a loaded schema to the editor and parse it immediately.
  async function applyLoadedSchema(s: { text: string; entry: string; endian: Endianness }) {
    setSchemaText(s.text);
    setEntry(s.entry);
    setEndian(s.endian);
    await runParse(s.text, s.entry, s.endian);
  }

  async function handlePickFromLibrary(id: string) {
    if (!id) return;
    try {
      await applyLoadedSchema(await libraryLoad(id));
    } catch (e) {
      setSchemaError(String(e));
    }
  }

  function beginSaveToLibrary() {
    setLibName(entry || "My schema");
    setLibDesc("");
    setSavingLib(true);
  }

  async function confirmSaveToLibrary() {
    try {
      await libraryAdd(libName.trim() || "schema", entry, endian, libDesc.trim(), schemaText);
      setLibrary(await libraryList());
      setSavingLib(false);
    } catch (e) {
      setSchemaError(String(e));
    }
  }

  async function handleRemoveFromLibrary(id: string) {
    try {
      await libraryRemove(id);
      setLibrary(await libraryList());
    } catch (e) {
      setSchemaError(String(e));
    }
  }

  async function handleExportSchema() {
    try {
      const path = await save({
        title: "Export schema",
        defaultPath: `${(entry || "schema").toLowerCase()}.schema`,
        filters: [{ name: "Schema", extensions: ["schema"] }],
      });
      if (typeof path !== "string") return;
      await exportSchema(path, entry || "schema", entry, endian, "", schemaText);
    } catch (e) {
      setSchemaError(String(e));
    }
  }

  async function handleImportSchema() {
    try {
      const path = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Schema", extensions: ["schema", "txt"] }],
      });
      if (typeof path !== "string") return;
      await applyLoadedSchema(await importSchema(path));
    } catch (e) {
      setSchemaError(String(e));
    }
  }

  // --- Compare against another file -----------------------------------------

  /** Pick a second file and diff the open one against it. */
  async function handleCompare() {
    setError(null);
    try {
      const path = await open({ multiple: false, directory: false, title: "Compare against…" });
      if (typeof path !== "string") return; // cancelled
      const st = await compareOpen(path);
      setCompare(st);
      setCompareVersion((v) => v + 1);
      // Land on the first difference: with a diff open, that is what you came for.
      if (st.first_change != null) selectByte(st.first_change);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleCompareClose() {
    try {
      await compareClose();
    } catch (e) {
      setError(String(e));
    }
    setCompare(null);
    setOtherTree(null);
    setCompareVersion((v) => v + 1);
  }

  /** Step to the next (or previous) changed region. */
  async function stepChange(forward: boolean) {
    if (!compare) return;
    try {
      const next =
        selected == null
          ? forward
            ? compare.first_change
            : await compareSeek(compare.a_len, false)
          : await compareSeek(selected, forward);
      if (next != null) selectByte(next);
    } catch (e) {
      setError(String(e));
    }
  }

  // Run the schema against the compared file too, so every field can show what
  // it held there. Keyed on `tree`, which is replaced by every parse — that is
  // exactly when the other side needs re-running.
  useEffect(() => {
    if (!compare || tree == null) {
      setOtherTree(null);
      return;
    }
    let alive = true;
    compareParse(schemaText, entry, endian)
      .then((out) => alive && setOtherTree(out.tree))
      .catch(() => alive && setOtherTree(null));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compare, tree]);

  // Drag a column divider. The right column grows when dragged leftwards, so
  // its handle is inverted; the hex column absorbs the slack either way.
  function startResize(which: "tree" | "vinspect" | "right", e: React.PointerEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = colW[which];
    const dir = which === "right" ? -1 : 1;
    function move(ev: PointerEvent) {
      const next = Math.max(140, Math.min(900, startW + dir * (ev.clientX - startX)));
      setColW((c) => ({ ...c, [which]: next }));
    }
    function up() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  // Byte -> field.
  function selectByte(offset: number) {
    setSelected(offset);
    if (tree) {
      const found = findFieldAtOffset(tree, offset);
      setActivePath(found?.path ?? null);
      setSelectedNode(found?.node ?? null);
      setHighlight(found ? { start: found.node.offset, end: found.node.offset + found.node.size } : null);
    }
  }

  /**
   * Jump the hex view to where a parse stopped. A fault inside a `decode`d
   * buffer has no file position - those bytes are not on disk - so it selects
   * the encoded field instead of pointing at an unrelated byte.
   */
  function jumpToFault(f: Fault) {
    if (f.decoded) return;
    setSelected(f.offset);
  }

  // Field -> bytes.
  function selectField(node: FieldNode, path: string) {
    setActivePath(path);
    setSelectedNode(node);
    setHighlight({ start: node.offset, end: node.offset + node.size });
    setSelected(node.offset);
  }

  // --- Editing (Phase 10) ---------------------------------------------------

  // After any edit, refresh the views that read bytes: bump the hex version,
  // re-run the schema so tree values update, and refresh the current selection.
  async function refreshAfterEdit(status: EditStatus) {
    setEdit(status);
    setEditVersion((v) => v + 1);
    if (tree) {
      try {
        const out = await parseSchema(schemaText, entry, endian);
        setTree(out.tree);
        setFault(out.fault ?? null);
        setCoverage(out.coverage ?? null);
      } catch {
        /* keep the previous tree if a re-parse fails */
      }
    }
    if (selected != null) interpret(selected).then(setInterp).catch(() => {});
    if (selectedNode && selectedNode.size > 0) {
      readRange(selectedNode.offset, Math.min(selectedNode.size, 32)).then(setRawBytes).catch(() => {});
    }
    // An edit moves the open file away from what the diff was computed against.
    if (compare) {
      try {
        setCompare(await compareRefresh());
        setCompareVersion((v) => v + 1);
      } catch {
        /* keep showing the previous diff rather than dropping the comparison */
      }
    }
  }

  // Commit an edited value for the selected field. Returns an error message to
  // show inline, or null on success.
  async function commitFieldEdit(value: string): Promise<string | null> {
    if (!selectedNode) return "No field selected.";
    const kind = selectedNode.value.kind;
    if (!isEditableKind(kind)) return "This field type can't be edited.";
    try {
      const status = await setFieldValue(selectedNode.offset, selectedNode.size, kind, endian, value);
      await refreshAfterEdit(status);
      return null;
    } catch (e) {
      return String(e);
    }
  }

  /** Rewrite mismatching checksums with the values their bytes produce. */
  async function handleFixChecksums() {
    try {
      const out = await fixChecksums(schemaText, entry, endian);
      await refreshAfterEdit(out.status);
      if (out.remaining > 0) {
        setError(
          `Fixed ${out.fixed} checksum(s); ${out.remaining} still do not match. ` +
            "A checksum that covers itself, or a field too narrow for the value, cannot be repaired this way.",
        );
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleUndo() {
    try {
      await refreshAfterEdit(await undoEdit());
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleRedo() {
    try {
      await refreshAfterEdit(await redoEdit());
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleRevert() {
    try {
      await refreshAfterEdit(await revertEdits());
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleSave() {
    try {
      const info = await saveFile();
      setFile(info);
      setEdit(await editStatus());
      setEditVersion((v) => v + 1);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleSaveAs() {
    try {
      const path = await save({ title: "Save binary as", defaultPath: file?.name });
      if (typeof path !== "string") return;
      const info = await saveFileAs(path);
      setFile(info);
      setEdit(await editStatus());
      setEditVersion((v) => v + 1);
    } catch (e) {
      setError(String(e));
    }
  }

  // Editor keyboard shortcuts: Ctrl+S save, Ctrl+Z undo, Ctrl+Y / Ctrl+Shift+Z redo.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!file) return;
      if (e.key === "Escape" && selection) { setSelection(null); return; }
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "s") { e.preventDefault(); handleSave(); }
      else if (k === "z" && !e.shiftKey) { e.preventDefault(); handleUndo(); }
      else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); handleRedo(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const valid = tree != null && !schemaError && fault == null;
  /** Short status word: a broken schema and an absent one are not the same thing. */
  const status = tree == null ? (schemaError ? "error" : "no schema") : fault ? "1 fault" : "parsed";
  const dirty = edit?.dirty ?? false;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Nybble</span>
        <button onClick={handleOpen}>Open File…</button>
        <button className="ghost" onClick={() => setShowPlugins(true)} title="Manage format plugins">Plugins</button>
        {file && (
          <button
            className={"ghost" + (compare ? " on" : "")}
            onClick={handleCompare}
            title="Diff this file against another one"
          >
            Compare…
          </button>
        )}
        {file && <span className="tab">{file.name}</span>}

        {file && (
          <form className="goto" onSubmit={handleGoto}>
            <label>Go</label>
            <input value={gotoText} onChange={(e) => setGotoText(e.target.value)} placeholder="0x1A40" spellCheck={false} />
          </form>
        )}
        {file && (
          <form className="search" onSubmit={handleSearch}>
            <select value={searchKind} onChange={(e) => setSearchKind(e.target.value as SearchKind)}>
              <option value="text">Text</option>
              <option value="hex">Hex</option>
              <option value="utf16">UTF-16</option>
              <option value="value">Value</option>
            </select>
            {searchKind === "value" && (
              <select value={valueWidth} onChange={(e) => setValueWidth(Number(e.target.value))} title="Integer width (uses the schema's endianness)">
                <option value={1}>u8</option>
                <option value={2}>u16</option>
                <option value={4}>u32</option>
                <option value={8}>u64</option>
              </select>
            )}
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={searchKind === "hex" ? "89 50" : searchKind === "value" ? "42 or 0x2A" : "find…"}
              spellCheck={false}
            />
            <button type="submit">Find</button>
            {matches.length > 0 && (
              <>
                <button type="button" className="ghost" onClick={() => stepMatch(-1)} title="Previous">‹</button>
                <span className="match-count">{matchIndex + 1}/{matches.length}</span>
                <button type="button" className="ghost" onClick={() => stepMatch(1)} title="Next">›</button>
              </>
            )}
          </form>
        )}

        <div className="spacer" />
        {file && formats.length > 0 && (
          <span className="format-badge" title={`${formats[0].description} (${formats[0].confidence}%)`}>{formats[0].format}</span>
        )}
        {file && <span className="pill">{endian.toUpperCase()}</span>}
        {file && <span className="pill">16 / row</span>}
        {file && (
          <span className={"valid" + (valid ? " ok" : "") + (fault ? " fault" : "")}>
            ● {tree == null ? (schemaError ? "error" : "no schema") : fault ? "1 fault" : "valid"}
          </span>
        )}

        {file && (
          <div className="edit-tools">
            {dirty && (
              <span className="dirty-badge" title={`${edit?.dirty_count ?? 0} byte(s) changed`}>
                ● {edit?.dirty_count ?? 0} edited
              </span>
            )}
            {badChecks > 0 && (
              <button
                className="fix-btn"
                onClick={handleFixChecksums}
                title="Rewrite each mismatching checksum with the value its bytes produce"
              >
                Fix {badChecks} checksum{badChecks === 1 ? "" : "s"}
              </button>
            )}
            <button className="ghost" onClick={handleUndo} disabled={!edit?.can_undo} title="Undo (Ctrl+Z)">↶</button>
            <button className="ghost" onClick={handleRedo} disabled={!edit?.can_redo} title="Redo (Ctrl+Y)">↷</button>
            <button className="ghost" onClick={handleRevert} disabled={!dirty} title="Discard all edits">Revert</button>
            <button className="save-btn" onClick={handleSave} disabled={!dirty} title="Save in place (Ctrl+S, backs up .bak)">Save</button>
            <button className="ghost" onClick={handleSaveAs} title="Save a copy">Save As…</button>
          </div>
        )}
      </header>

      {error && <div className="error-bar" onClick={() => setError(null)}>{error}</div>}

      {!file ? (
        <div className="empty-state">
          <h1>Nybble</h1>
          <p>Open a binary file to inspect its structure.</p>
          <button onClick={handleOpen}>Open File…</button>
        </div>
      ) : (
        <>
        {compare && (
          <div className="compare-bar">
            <span className="cmp-label">diff vs</span>
            <span className="cmp-name" title={compare.path}>{compare.name}</span>
            {compare.identical ? (
              <span className="cmp-same">byte-for-byte identical</span>
            ) : (
              <>
                <span className="cmp-stat">
                  <b>{compare.changed_bytes.toLocaleString()}</b> bytes differ in{" "}
                  <b>{compare.region_count.toLocaleString()}</b>{" "}
                  {compare.region_count === 1 ? "region" : "regions"}
                </span>
                {compare.a_len !== compare.b_len && (
                  <span className="cmp-size" title="This file is longer/shorter than the other one">
                    size {compare.a_len > compare.b_len ? "+" : "−"}
                    {Math.abs(compare.a_len - compare.b_len).toLocaleString()} B
                  </span>
                )}
                {compare.truncated && (
                  <span className="cmp-warn" title="Too many regions to list them all — the byte count is still exact">
                    list capped
                  </span>
                )}
                <button className="ghost" onClick={() => stepChange(false)} title="Previous change">‹</button>
                <button className="ghost" onClick={() => stepChange(true)} title="Next change">›</button>
              </>
            )}
            <div className="spacer" />
            <button className="ghost" onClick={handleCompareClose} title="Stop comparing">Close</button>
          </div>
        )}
        {suggest && !builtin && (
          <div className="suggest-bar">
            <span className="sug-label">registry</span>
            {suggest.matches.length > 0 ? (
              <>
                <span className="sug-text">
                  Looks like <b>{suggest.matches[0].name}</b>
                  <span className="sug-format"> · {suggest.matches[0].format}</span>
                </span>
                <button
                  className="builtin-btn"
                  disabled={suggestBusy}
                  onClick={() => handleInstallSuggested(suggest.matches[0])}
                  title={suggest.matches[0].description}
                >
                  {suggestBusy ? "Installing…" : "Install & use"}
                </button>
                {suggest.matches.slice(1, 4).map((m) => (
                  <button
                    key={m.id}
                    className="ghost"
                    disabled={suggestBusy}
                    onClick={() => handleInstallSuggested(m)}
                    title={`${m.description} — install ${m.name}`}
                  >
                    or {m.name}
                  </button>
                ))}
              </>
            ) : suggest.checked ? (
              <span className="sug-text dim">No registry pack recognises this file.</span>
            ) : (
              <>
                <span className="sug-text">No installed schema reads this file.</span>
                <button
                  className="ghost"
                  disabled={suggestBusy}
                  onClick={handleCheckRegistry}
                  title="Downloads the public list of registry formats and matches it here. Nothing from this file is sent."
                >
                  {suggestBusy ? "Checking…" : "Check the registry"}
                </button>
              </>
            )}
            <div className="spacer" />
            <button className="ghost" onClick={() => setSuggest(null)} title="Hide until the next file">Dismiss</button>
          </div>
        )}
        <FileMap
          fileLen={file.len}
          root={tree}
          selected={selected}
          activePath={activePath}
          coverage={coverage}
          onSelect={selectField}
          onSeek={selectByte}
        />
        <main
          className="cols"
          style={{
            gridTemplateColumns: `${colW.tree}px 6px ${colW.vinspect}px 6px minmax(200px, 1fr) 6px ${colW.right}px`,
          }}
        >
          {/* Column 1 — parse tree */}
          <section className="col col-tree">
            <div className="col-head">Parse tree
              <button className="popout-btn" title="Pop out to its own window" onClick={() => popOut("tree")}>⤢</button>
            </div>
            <div className="col-body">
              {tree ? (
                <StructureTree
                  root={tree}
                  activePath={activePath}
                  colorFor={colorFor}
                  fault={fault}
                  otherRoot={otherTree}
                  onSelect={selectField}
                />
              ) : (
                <p className="hint">
                  Parse a schema to see the structure — or drag across bytes in the hex
                  view to turn them into fields.
                </p>
              )}
            </div>
          </section>

          <div className="col-splitter" onPointerDown={(e) => startResize("tree", e)} title="Drag to resize" />

          {/* Column 2 — value inspector */}
          <section className="col col-vinspect">
            <div className="col-head">Value inspector
              <button className="popout-btn" title="Pop out to its own window" onClick={() => popOut("vinspect")}>⤢</button>
            </div>
            <div className="col-body">
              <ValueInspector node={selectedNode} raw={rawBytes} onCommit={commitFieldEdit} />
            </div>
          </section>

          <div className="col-splitter" onPointerDown={(e) => startResize("vinspect", e)} title="Drag to resize" />

          {/* Column 3 — hex view */}
          <section className="col col-hex">
            <div className="col-head">
              Hex view
              {selection != null ? (
                <span className="sel-label">
                  selection 0x{selection.start.toString(16).toUpperCase()}
                  –0x{selection.end.toString(16).toUpperCase()} ({selection.end - selection.start} B)
                </span>
              ) : (
                selected != null && (
                  <span className="sel-label">selection 0x{selected.toString(16).toUpperCase()}</span>
                )
              )}
              <div className="view-toggle">
                <button className={"seg" + (viewMode === "hex" ? " on" : "")} onClick={() => setViewMode("hex")}>Hex</button>
                <button className={"seg" + (viewMode === "text" ? " on" : "")} onClick={() => setViewMode("text")}>Text</button>
              </div>
              <button className="popout-btn" title="Pop out to its own window" onClick={() => popOut("hex")}>⤢</button>
            </div>
            {selection && !dragging && (
              <FieldBuilder
                key={`${selection.start}:${selection.end}`}
                range={selection}
                bytes={selBytes}
                endian={endian}
                target={targetStructName(schemaText, entry)}
                gap={gap}
                overlaps={overlaps}
                onAdd={addSelectionField}
                onCancel={() => setSelection(null)}
              />
            )}
            <HexView
              key={file.path}
              fileLen={file.len}
              selected={selected}
              highlight={highlight}
              mode={viewMode}
              colorAt={colorFor}
              isEdited={isEdited}
              editVersion={editVersion}
              compare={hexCompare}
              compareVersion={compareVersion}
              onSelect={selectByte}
              selection={selection}
              onSelectRange={pickRange}
            />
          </section>

          <div className="col-splitter" onPointerDown={(e) => startResize("right", e)} title="Drag to resize" />

          {/* Column 4 — data preview + schema + extras */}
          <section className="col col-right">
            <div className="rpanel">
              <div className="col-head">Data preview
                <button className="popout-btn" title="Pop out to its own window" onClick={() => popOut("preview")}>⤢</button>
              </div>
              <div className="col-body">
                <DataPreview node={selectedNode} interp={interp} />
                {guesses.length > 0 && (
                  <div className="guesses">
                    {guesses.map((g, i) => (
                      <div key={i} className="guess">
                        <span className="guess-label">{g.label}</span>
                        <span className="guess-detail">{g.detail}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="rpanel schema-panel">
              <div className="col-head">
                Schema
                <div className="schema-controls">
                  {builtin && (
                    <button className="builtin-btn" onClick={handleUseBuiltin} title={`Load the detected ${formats[0]?.format} schema`}>
                      Use {formats[0]?.format}
                    </button>
                  )}
                  <select
                    className="lib-select"
                    value=""
                    onChange={(e) => { handlePickFromLibrary(e.target.value); e.currentTarget.value = ""; }}
                    title="Load a schema from the library"
                  >
                    <option value="">Library…</option>
                    <optgroup label="Built-in">
                      {library.filter((s) => s.source === "builtin").map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </optgroup>
                    {library.some((s) => s.source === "user") && (
                      <optgroup label="My schemas">
                        {library.filter((s) => s.source === "user").map((s) => (
                          <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                  <select value={endian} onChange={(e) => setEndian(e.target.value as Endianness)}>
                    <option value="le">LE</option>
                    <option value="be">BE</option>
                  </select>
                  <button className="ghost" onClick={beginSaveToLibrary} title="Save this schema to your library">Save★</button>
                  <button className="ghost" onClick={handleExportSchema} title="Export to a shareable file">Export</button>
                  <button className="ghost" onClick={() => setShowPack(true)} title="Export as a registry plugin pack (plugin.toml)">Pack…</button>
                  <button className="ghost" onClick={handleImportSchema} title="Import a schema file">Import</button>
                  <button className="popout-btn" title="Pop out to its own window" onClick={() => popOut("schema")}>⤢</button>
                </div>
              </div>
              {savingLib && (
                <div className="lib-save">
                  <input className="lib-save-name" value={libName} onChange={(e) => setLibName(e.target.value)} placeholder="schema name" spellCheck={false} autoFocus />
                  <input className="lib-save-desc" value={libDesc} onChange={(e) => setLibDesc(e.target.value)} placeholder="description (optional)" spellCheck={false} />
                  <button className="vedit-apply" onClick={confirmSaveToLibrary}>Save</button>
                  <button className="ghost" onClick={() => setSavingLib(false)}>Cancel</button>
                </div>
              )}
              {library.some((s) => s.source === "user") && (
                <div className="lib-user-row">
                  <span className="lib-user-label">My schemas:</span>
                  {library.filter((s) => s.source === "user").map((s) => (
                    <span key={s.id} className="lib-chip" title={s.description || s.name}>
                      <button className="lib-chip-load" onClick={() => handlePickFromLibrary(s.id)}>{s.name}</button>
                      <button className="lib-chip-x" title="Remove from library" onClick={() => handleRemoveFromLibrary(s.id)}>×</button>
                    </span>
                  ))}
                </div>
              )}
              <input className="entry-input" value={entry} onChange={(e) => setEntry(e.target.value)} placeholder="entry struct (default: first)" spellCheck={false} />
              <SchemaEditor
                value={schemaText}
                onChange={setSchemaText}
                error={schemaError ?? fault?.message}
                errorLine={fault?.schema_line}
              />
              {schemaError && <div className="schema-error">{schemaError}</div>}
              {fault && (
                <div
                  className={"fault-bar" + (fault.decoded ? "" : " jumpable")}
                  onClick={() => jumpToFault(fault)}
                  title={
                    fault.decoded
                      ? "This offset is inside decoded bytes, which have no position in the file"
                      : "Jump to this byte"
                  }
                >
                  <span className="fault-where">
                    {fault.decoded ? "+" : ""}0x{fault.offset.toString(16).toUpperCase()}
                  </span>
                  <span className="fault-path">{fault.path}</span>
                  {fault.schema_line != null && <span className="fault-line">line {fault.schema_line}</span>}
                  <span className="fault-msg">{fault.message}</span>
                </div>
              )}
              {packNotice && (
                <div className="schema-notice" onClick={() => setPackNotice(null)} title="Dismiss">{packNotice}</div>
              )}
              <button className="reparse" onClick={handleParse}>Re-parse</button>
            </div>

            <div className="rpanel extras-panel">
              <div className="col-head">Shape · entropy · strings</div>
              <div className="col-body">
                {shape && shape.hints.length > 0 && (
                  <div className="hints">
                    <div className="hints-head">
                      what this looks like
                      <span className="hints-region">
                        0x{shape.offset.toString(16).toUpperCase()} ·{" "}
                        {shape.len.toLocaleString()} B{shape.clamped ? " (capped)" : ""}
                      </span>
                    </div>
                    {shape.hints.map((h, i) => (
                      <button
                        key={i}
                        className="hint"
                        onClick={() => selectByte(h.offset)}
                        title={`Jump to 0x${h.offset.toString(16).toUpperCase()}`}
                      >
                        <span className="hint-label">{h.label}</span>
                        <span className="hint-detail">{h.detail}</span>
                      </button>
                    ))}
                  </div>
                )}
                {entropyData.length > 0 && <EntropyStrip data={entropyData} fileLen={file.len} onSeek={selectByte} />}
                <div className="strings-list">
                  {strings.slice(0, 200).map((s, i) => (
                    <div
                      key={i}
                      className={"string-hit" + (highlight?.start === s.offset ? " active" : "")}
                      onClick={() => { setSelected(s.offset); setHighlight({ start: s.offset, end: s.offset + s.len }); }}
                      title={`0x${s.offset.toString(16)} · ${s.encoding}`}
                    >
                      <span className="string-off">{s.offset.toString(16).padStart(6, "0")}</span>
                      <span className="string-text">{s.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>
        </main>
        </>
      )}

      <footer className="statusbar">
        {file ? (
          <>
            <span className={"status-dot" + (valid ? " ok" : "") + (fault ? " fault" : "")} />
            <span>{status}</span>
            {selected != null && <span>· off 0x{selected.toString(16).toUpperCase()}</span>}
            {selection != null && (
              <span>· sel {selection.end - selection.start} B</span>
            )}
            <span>· {file.len.toLocaleString()} B</span>
            <span>· {endian === "le" ? "little-endian" : "big-endian"}</span>
            {compare && (
              <span className="status-diff">
                · diff vs {compare.name}
                {compare.identical ? " (identical)" : ` (${compare.changed_bytes.toLocaleString()} B)`}
              </span>
            )}
            <div className="spacer" />
            <span>{formats.length > 0 ? formats[0].format : "unknown format"}</span>
          </>
        ) : (
          <span>No file open</span>
        )}
      </footer>

      {showPlugins && (
        <Plugins onClose={() => setShowPlugins(false)} onChanged={handlePluginsChanged} />
      )}
      {showPack && (
        <ExportPack
          schemaText={schemaText}
          entry={entry}
          endian={endian}
          onClose={() => setShowPack(false)}
          onDone={(m) => setPackNotice(m)}
        />
      )}
    </div>
  );
}
