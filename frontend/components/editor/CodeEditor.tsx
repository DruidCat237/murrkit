"use client";

/**
 * CodeEditor — a Cursor-like code editor over the REAL Phaser game source
 * (`phaser_game/`), powered by Monaco (`@monaco-editor/react`).
 *
 *   - Left: file tree (FileTree.tsx) backed by GET /api/fs/tree.
 *   - Right: Monaco editor. Language inferred from extension; dark theme;
 *     built-in TS IntelliSense (the user's "podpowiedzi na tab"), bracket
 *     matching, word-wrap on for markdown.
 *   - Read via GET /api/fs/read, save via POST /api/fs/write.
 *   - Ctrl/Cmd+S saves; a dirty-dot shows in the path bar; the green "Save"
 *     button works too.
 *   - Selecting text reveals an "Edit with chat" floating button (and a
 *     right-click context-menu action) that prefills the chat with the
 *     selection and opens Chat in a SPLIT next to Code (Code stays visible).
 *
 * Monaco is heavy + browser-only: it's lazy-loaded by CenterTabContent and the
 * <Editor> component itself only mounts client-side, so SSR is never hit.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { type OnMount, type Monaco } from "@monaco-editor/react";
import type { editor as MonacoEditor, IDisposable } from "monaco-editor";
import { Save, RotateCw, FileText, MessageSquarePlus } from "lucide-react";
import FileTree from "./FileTree";
import { readFsFile, writeFsFile } from "@/lib/api";
import { useLayout } from "@/store/layout";
import { useToasts } from "../Toaster";

// Near-black theme tuned to the app chrome. Registered once on first mount.
const THEME_NAME = "phaser2d-dark";
let themeRegistered = false;

function ensureTheme(monaco: Monaco) {
  if (themeRegistered) return;
  monaco.editor.defineTheme(THEME_NAME, {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#0b0d12",
      "editorGutter.background": "#0b0d12",
      "editor.lineHighlightBackground": "#151821",
      "editorLineNumber.foreground": "#3a4151",
      "editorLineNumber.activeForeground": "#8b94a7",
      "editor.selectionBackground": "#264f78",
      "editorCursor.foreground": "#7aa2f7",
    },
  });
  themeRegistered = true;
}

export default function CodeEditor({ initialFile }: { initialFile?: string }) {
  const [activePath, setActivePath] = useState<string | null>(initialFile ?? null);
  const [contents, setContents] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // Floating "Edit with chat" button position (viewport-absolute), or null.
  const [editBtn, setEditBtn] = useState<{ top: number; left: number } | null>(null);

  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const disposablesRef = useRef<IDisposable[]>([]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Keep the latest activePath available to Monaco command callbacks (which
  // close over the first render otherwise).
  const activePathRef = useRef<string | null>(activePath);
  activePathRef.current = activePath;
  const contentsRef = useRef<string>(contents);
  contentsRef.current = contents;

  const toast = useToasts();

  // Layout actions for the "Edit with chat" split.
  const splitCenterTab = useLayout((s) => s.splitCenterTab);
  const setActiveCenterTab = useLayout((s) => s.setActiveCenterTab);

  const pick = useCallback(async (path: string) => {
    setActivePath(path);
    setLoading(true);
    setEditBtn(null);
    try {
      const r = await readFsFile(path);
      setContents(r.content);
      setDirty(false);
    } catch (e) {
      toast.error(`Failed to load ${path}`, { description: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  // Load the initial file once on mount (if provided).
  useEffect(() => {
    if (initialFile) void pick(initialFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = useCallback(async () => {
    const path = activePathRef.current;
    if (!path) return;
    setSaving(true);
    try {
      const r = await writeFsFile(path, contentsRef.current);
      toast.success(`Saved ${path}`, { description: `${r.bytes} bytes` });
      setDirty(false);
    } catch (e) {
      toast.error(`Save failed`, { description: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }, [toast]);

  // Push the current Monaco selection into the chat and open Chat in a split
  // so the Code tab stays visible side-by-side (the key Cursor feature).
  const editWithChat = useCallback(() => {
    const ed = editorRef.current;
    const path = activePathRef.current;
    if (!ed || !path) return;
    const model = ed.getModel();
    const selection = ed.getSelection();
    if (!model || !selection || selection.isEmpty()) return;
    const selected = model.getValueInRange(selection);
    if (!selected.trim()) return;

    const lang = monacoLanguageFor(path);
    const prefill = `In \`${path}\`:\n\`\`\`${lang}\n${selected}\n\`\`\`\n\n`;
    window.dispatchEvent(new CustomEvent("chat:prefill", { detail: prefill }));

    // Keep Code visible: move the (sticky) Chat tab into the right pane and
    // keep the Code tab active in the left pane. setActiveCenterTab keeps the
    // global active id on Code; DockArea renders Chat as the lone right-pane
    // tab, so the user sees Code | Chat side-by-side.
    const codeTab = useLayout.getState().centerTabs.find(
      (t) => t.kind === "code" && t.file === path,
    ) ?? useLayout.getState().centerTabs.find((t) => t.kind === "code");
    const chatTab = useLayout.getState().centerTabs.find((t) => t.kind === "chat");
    if (chatTab) splitCenterTab(chatTab.id, "vertical");
    if (codeTab) setActiveCenterTab(codeTab.id);
    setEditBtn(null);
  }, [splitCenterTab, setActiveCenterTab]);
  // Stable ref so the Monaco action (registered once) calls the latest version.
  const editWithChatRef = useRef(editWithChat);
  editWithChatRef.current = editWithChat;

  const onMount: OnMount = useCallback((ed, monaco) => {
    // <Editor key={activePath}> remounts Monaco per file — dispose the prior
    // instance's listeners/actions so they don't accumulate across switches.
    disposablesRef.current.forEach((d) => { try { d.dispose(); } catch { /* ignore */ } });
    disposablesRef.current = [];

    editorRef.current = ed;
    ensureTheme(monaco);
    monaco.editor.setTheme(THEME_NAME);

    // Relax TS validation: this is a viewer/quick-edit over files that import
    // Phaser etc. without the full project's typeRoots, so red squiggles for
    // unresolved modules would be noise. IntelliSense/completions still work.
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: false,
    });
    monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
      target: monaco.languages.typescript.ScriptTarget.ESNext,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
      allowNonTsExtensions: true,
      jsx: monaco.languages.typescript.JsxEmit.React,
    });

    // Ctrl/Cmd+S → save.
    disposablesRef.current.push(
      ed.addAction({
        id: "phaser2d-save",
        label: "Save File",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        run: () => { void save(); },
      }),
    );

    // Right-click context-menu "Edit with chat".
    disposablesRef.current.push(
      ed.addAction({
        id: "phaser2d-edit-with-chat",
        label: "Edit with chat",
        contextMenuGroupId: "navigation",
        contextMenuOrder: 0,
        precondition: "editorHasSelection",
        run: () => editWithChatRef.current(),
      }),
    );

    // Floating "Edit with chat" button anchored to the selection.
    const updateFloatingBtn = () => {
      const sel = ed.getSelection();
      const host = containerRef.current;
      if (!sel || sel.isEmpty() || !host) { setEditBtn(null); return; }
      const pos = { lineNumber: sel.endLineNumber, column: sel.endColumn };
      const top = ed.getTopForPosition(pos.lineNumber, pos.column) - ed.getScrollTop();
      const left = ed.getOffsetForColumn(pos.lineNumber, pos.column) - ed.getScrollLeft();
      const hostRect = host.getBoundingClientRect();
      // Layout is relative to the editor container; clamp inside it.
      const editorDom = ed.getDomNode();
      const editorRect = editorDom?.getBoundingClientRect();
      const gutter = editorRect ? editorRect.left - hostRect.left : 0;
      setEditBtn({
        top: Math.max(4, top - 30),
        left: Math.min(Math.max(8, left + gutter), host.clientWidth - 130),
      });
    };
    disposablesRef.current.push(ed.onDidChangeCursorSelection(updateFloatingBtn));
    disposablesRef.current.push(ed.onDidScrollChange(updateFloatingBtn));
    disposablesRef.current.push(ed.onDidBlurEditorWidget(() => {
      // Delay so a click on the floating button still registers before hide.
      window.setTimeout(() => setEditBtn(null), 150);
    }));
  }, [save]);

  // Dispose Monaco listeners on unmount.
  useEffect(() => {
    return () => {
      disposablesRef.current.forEach((d) => { try { d.dispose(); } catch { /* ignore */ } });
      disposablesRef.current = [];
    };
  }, []);

  const language = activePath ? monacoLanguageFor(activePath) : "plaintext";

  return (
    <div className="h-full w-full flex bg-bg overflow-hidden">
      <div className="w-56 shrink-0 h-full">
        <FileTree onPick={pick} activePath={activePath} root="phaser_game" />
      </div>
      <div className="flex-1 min-w-0 h-full flex flex-col">
        {/* path bar */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-line shrink-0 text-xs">
          <FileText className="h-3.5 w-3.5 text-text-dim" />
          <span className="font-mono text-text-dim truncate flex-1" title={activePath ?? ""}>
            {activePath ?? "(no file selected)"}
            {dirty && <span className="ml-1.5 inline-block h-2 w-2 rounded-full bg-accent-warn align-middle" title="Unsaved changes" />}
          </span>
          <button
            disabled={!dirty || saving || !activePath}
            onClick={() => void save()}
            className="btn btn-primary text-xs flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
            title="Save (Ctrl/Cmd+S)"
          >
            <Save className="h-3 w-3" /> {saving ? "Saving…" : "Save"}
          </button>
          <button
            onClick={() => activePath && void pick(activePath)}
            disabled={!activePath || loading}
            className="btn btn-ghost text-xs flex items-center gap-1 disabled:opacity-40"
            title="Reload from disk"
          >
            <RotateCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>

        {/* editor body */}
        <div ref={containerRef} className="flex-1 min-h-0 relative">
          {!activePath ? (
            <EmptyEditor />
          ) : (
            <>
              <Editor
                key={activePath}
                height="100%"
                width="100%"
                theme={THEME_NAME}
                language={language}
                value={contents}
                onChange={(v) => { setContents(v ?? ""); setDirty(true); }}
                onMount={onMount}
                loading={<div className="h-full flex items-center justify-center text-xs text-text-subtle">Loading editor…</div>}
                options={{
                  fontSize: 13,
                  minimap: { enabled: false },
                  wordWrap: language === "markdown" ? "on" : "off",
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  tabSize: 2,
                  bracketPairColorization: { enabled: true },
                  matchBrackets: "always",
                  renderWhitespace: "none",
                  smoothScrolling: true,
                  cursorBlinking: "smooth",
                  fixedOverflowWidgets: true,
                  padding: { top: 8 },
                }}
              />
              {editBtn && (
                <button
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); editWithChat(); }}
                  className="absolute z-20 flex items-center gap-1 rounded-md border border-accent/60 bg-bg-panel px-2 py-1 text-[11px] text-accent shadow-lg hover:bg-accent hover:text-bg"
                  style={{ top: editBtn.top, left: editBtn.left }}
                  title="Send the selection to chat and open Chat alongside"
                >
                  <MessageSquarePlus className="h-3 w-3" /> Edit with chat
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyEditor() {
  return (
    <div className="h-full flex items-center justify-center text-text-subtle">
      <div className="text-center max-w-sm px-6">
        <FileText className="h-10 w-10 mx-auto mb-3 opacity-40" />
        <div className="text-sm mb-1">No file open</div>
        <div className="text-xs">
          Pick a file from the tree on the left to view + edit the real Phaser
          game source. Select text and click <span className="text-accent">Edit with chat</span> to send it to Claude.
        </div>
      </div>
    </div>
  );
}

/** Monaco language id from a file path. */
function monacoLanguageFor(path: string): string {
  const p = path.toLowerCase();
  if (p.endsWith(".ts") || p.endsWith(".tsx")) return "typescript";
  if (p.endsWith(".js") || p.endsWith(".jsx") || p.endsWith(".mjs") || p.endsWith(".cjs")) return "javascript";
  if (p.endsWith(".json")) return "json";
  if (p.endsWith(".yaml") || p.endsWith(".yml")) return "yaml";
  if (p.endsWith(".css") || p.endsWith(".scss")) return "css";
  if (p.endsWith(".html") || p.endsWith(".htm")) return "html";
  if (p.endsWith(".md") || p.endsWith(".markdown")) return "markdown";
  if (p.endsWith(".py")) return "python";
  return "plaintext";
}
