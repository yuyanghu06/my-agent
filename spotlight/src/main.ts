import { invoke, Channel, convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import MarkdownIt from "markdown-it";
// @ts-ignore — no published types
import mdKatex from "@vscode/markdown-it-katex";
import "katex/dist/katex.min.css";

const MIN_HEIGHT = 52;
const MAX_HEIGHT = 720;
const PASTE_CHIP_THRESHOLD = 280;
const COMPOSER_MAX_PX = 180; // textarea cap before it scrolls internally
const STICKY_BOTTOM_TOLERANCE = 24;

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
// KaTeX: supports $…$ inline and $$…$$ block, plus \(…\) / \[…\].
// throwOnError:false keeps malformed math from blowing up the render — KaTeX
// renders the offending source in red instead, which is the right UX while
// the model is mid-stream and TeX may be temporarily incomplete.
md.use((mdKatex as any).default ?? mdKatex, { throwOnError: false, strict: false });

const composer = document.getElementById("composer") as HTMLTextAreaElement;
const composerWrap = document.getElementById("composer-wrap") as HTMLDivElement;
const response = document.getElementById("response") as HTMLDivElement;
const responseInner = document.getElementById("response-inner") as HTMLDivElement;
const bar = document.querySelector(".bar") as HTMLDivElement;
const statusLine = document.getElementById("status") as HTMLDivElement;
const commandsEl = document.getElementById("commands") as HTMLDivElement;
const attachmentsEl = document.getElementById("attachments") as HTMLDivElement;
const win = getCurrentWindow();

const pinBtn = document.getElementById("pin-btn") as HTMLButtonElement | null;
const recordBtn = document.getElementById("record-btn") as HTMLButtonElement | null;
const autoshotBtn = document.getElementById("autoshot-btn") as HTMLButtonElement | null;
const settingsBtn = document.getElementById("settings-btn") as HTMLButtonElement | null;
const settingsPanel = document.getElementById("settings-panel") as HTMLDivElement | null;
const settingsCloseBtn = document.getElementById("settings-close") as HTMLButtonElement | null;

let pinned = false;
let recording = false;
let autoshotEnabled = false;

pinBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  void togglePin();
});

async function togglePin() {
  pinned = !pinned;
  pinBtn?.classList.toggle("active", pinned);
  pinBtn?.setAttribute("aria-pressed", pinned ? "true" : "false");
  if (pinBtn) {
    pinBtn.title = pinned ? "Unpin window" : "Keep window on top";
  }
  try {
    await win.setAlwaysOnTop(pinned);
  } catch (err) {
    console.error("setAlwaysOnTop failed", err);
    showToast("Pin failed: " + err);
    pinned = !pinned;
    pinBtn?.classList.toggle("active", pinned);
  }
}

autoshotBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  setAutoshot(!autoshotEnabled);
});

function setAutoshot(on: boolean) {
  autoshotEnabled = on;
  autoshotBtn?.classList.toggle("active", on);
  autoshotBtn?.setAttribute("aria-pressed", on ? "true" : "false");
  if (autoshotBtn) {
    autoshotBtn.title = on
      ? "Auto-screenshot ON — captures on submit"
      : "Auto-attach screenshot on submit";
  }
}

recordBtn?.addEventListener("click", async (e) => {
  e.preventDefault();
  e.stopPropagation();
  await toggleRecording();
});

async function toggleRecording() {
  if (!recordBtn) return;
  if (!recording) {
    try {
      await invoke("start_screen_capture");
      recording = true;
      recordBtn.classList.add("active");
      recordBtn.setAttribute("aria-pressed", "true");
      recordBtn.title = "Stop recording";
    } catch (err) {
      console.error("start_screen_capture failed", err);
      showToast("Recording failed to start: " + err);
    }
  } else {
    try {
      const clip = await invoke<{ path: string; name: string; size: number }>(
        "stop_screen_capture",
      );
      recording = false;
      recordBtn.classList.remove("active");
      recordBtn.setAttribute("aria-pressed", "false");
      recordBtn.title = "Record screen clip";
      attachedFiles.push({ path: clip.path, name: clip.name, size: clip.size });
      renderAttachments();
    } catch (err) {
      console.error("stop_screen_capture failed", err);
      showToast("Recording failed to stop: " + err);
      recording = false;
      recordBtn.classList.remove("active");
    }
  }
}

async function captureAndAttachScreenshot(): Promise<void> {
  try {
    const shot = await invoke<{ path: string; dataUrl: string }>(
      "capture_screenshot",
    );
    attachedImages.push({ path: shot.path, dataUrl: shot.dataUrl });
    renderAttachments();
  } catch (err) {
    console.error("capture_screenshot failed", err);
    showToast("Screenshot failed: " + err);
  }
}

// ============================================================
// Settings panel + hotkey registration
// ============================================================

type HotkeyName =
  | "togglePin"
  | "toggleRecording"
  | "toggleAutoScreenshot"
  | "snapScreenshot";
const HOTKEY_NAMES: HotkeyName[] = [
  "togglePin",
  "toggleRecording",
  "toggleAutoScreenshot",
  "snapScreenshot",
];
const hotkeys: Record<HotkeyName, string> = {
  togglePin: "",
  toggleRecording: "",
  toggleAutoScreenshot: "",
  snapScreenshot: "",
};

settingsBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  toggleSettingsPanel();
});
settingsCloseBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  hideSettingsPanel();
});

function toggleSettingsPanel() {
  if (!settingsPanel) return;
  if (settingsPanel.classList.contains("hidden")) showSettingsPanel();
  else hideSettingsPanel();
}
function showSettingsPanel() {
  if (!settingsPanel) return;
  settingsPanel.classList.remove("hidden");
  response.classList.add("hidden");
  renderHotkeyInputs();
  // Grow the window enough to show the panel comfortably.
  const target = Math.min(MAX_HEIGHT, Math.max(360, bar.offsetHeight + 320));
  invoke("resize_height", { height: target }).catch(() => {});
}
function hideSettingsPanel() {
  if (!settingsPanel) return;
  settingsPanel.classList.add("hidden");
  response.classList.remove("hidden");
  // If there's no chat content, snap back to the bar height. fitWindow only
  // grows — without snapToMin the window stays at the panel's tall size.
  if (response.classList.contains("empty")) {
    snapToMin();
  } else {
    fitWindow();
  }
}

function renderHotkeyInputs() {
  if (!settingsPanel) return;
  settingsPanel.querySelectorAll<HTMLDivElement>(".settings-row").forEach((row) => {
    const name = row.dataset.hotkey as HotkeyName | undefined;
    if (!name) return;
    const input = row.querySelector<HTMLInputElement>(".hotkey-input");
    if (input) input.value = formatAcceleratorForDisplay(hotkeys[name]);
  });
}

function formatAcceleratorForDisplay(acc: string): string {
  if (!acc) return "";
  return acc
    .replace(/CommandOrControl|CmdOrCtrl/g, "⌘")
    .replace(/Command|Cmd|Super/g, "⌘")
    .replace(/Control|Ctrl/g, "⌃")
    .replace(/Option|Alt/g, "⌥")
    .replace(/Shift/g, "⇧")
    .replace(/\+/g, " ");
}

// Build a Tauri accelerator string from a KeyboardEvent. Returns null if the
// event isn't a usable combo (no key, just modifiers, Esc as cancel).
function acceleratorFromEvent(e: KeyboardEvent): string | null {
  if (e.key === "Escape") return null;
  const parts: string[] = [];
  if (e.metaKey) parts.push("CommandOrControl");
  if (e.ctrlKey && !e.metaKey) parts.push("Control");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  const k = e.key;
  if (["Meta", "Control", "Alt", "Shift", "Dead"].includes(k)) return null;
  let key = k;
  if (k === " ") key = "Space";
  else if (k.length === 1) key = k.toUpperCase();
  else if (k.startsWith("Arrow")) key = k.replace("Arrow", "");
  parts.push(key);
  return parts.join("+");
}

settingsPanel?.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target.classList.contains("hotkey-clear")) {
    const row = target.closest<HTMLDivElement>(".settings-row");
    const name = row?.dataset.hotkey as HotkeyName | undefined;
    if (name) {
      hotkeys[name] = "";
      renderHotkeyInputs();
      void persistAndRegister();
    }
  }
});

settingsPanel?.addEventListener("focusin", (e) => {
  const t = e.target as HTMLElement;
  if (t.classList.contains("hotkey-input")) t.classList.add("recording");
});
settingsPanel?.addEventListener("focusout", (e) => {
  const t = e.target as HTMLElement;
  if (t.classList.contains("hotkey-input")) t.classList.remove("recording");
});

settingsPanel?.addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement;
  if (!target.classList.contains("hotkey-input")) {
    // Esc anywhere else in the panel closes it.
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      hideSettingsPanel();
    }
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  const row = target.closest<HTMLDivElement>(".settings-row");
  const name = row?.dataset.hotkey as HotkeyName | undefined;
  if (!name) return;
  if (e.key === "Escape") {
    (target as HTMLInputElement).blur();
    return;
  }
  const acc = acceleratorFromEvent(e);
  if (!acc) return;
  hotkeys[name] = acc;
  renderHotkeyInputs();
  void persistAndRegister();
  (target as HTMLInputElement).blur();
});

async function persistAndRegister() {
  try {
    await invoke("write_settings", { json: JSON.stringify({ hotkeys }, null, 2) });
  } catch (err) {
    console.error("write_settings failed", err);
  }
  await registerAllHotkeys();
}

// Tracks accelerators *we* registered, so we don't unregister the
// Cmd+Shift+Space toggle-window shortcut that Rust owns.
const registeredAccels = new Set<string>();
async function registerAllHotkeys() {
  const gs = await import("@tauri-apps/plugin-global-shortcut");
  for (const acc of registeredAccels) {
    try { await gs.unregister(acc); } catch {}
  }
  registeredAccels.clear();
  const bindings: Array<[string, () => void | Promise<void>]> = [
    [hotkeys.togglePin, () => togglePin()],
    [hotkeys.toggleRecording, () => toggleRecording()],
    [hotkeys.toggleAutoScreenshot, () => setAutoshot(!autoshotEnabled)],
    [hotkeys.snapScreenshot, () => captureAndAttachScreenshot()],
  ];
  for (const [acc, handler] of bindings) {
    if (!acc) continue;
    try {
      await gs.register(acc, (ev) => {
        if (ev.state === "Pressed") void handler();
      });
      registeredAccels.add(acc);
    } catch (err) {
      console.warn("register hotkey failed", acc, err);
    }
  }
}

async function loadSettingsAtStartup() {
  try {
    const raw = await invoke<string>("read_settings");
    const parsed = JSON.parse(raw || "{}");
    const h = parsed?.hotkeys ?? {};
    for (const n of HOTKEY_NAMES) {
      if (typeof h[n] === "string") hotkeys[n] = h[n];
    }
  } catch (err) {
    console.warn("read_settings failed", err);
  }
  await registerAllHotkeys();
}
void loadSettingsAtStartup();

// ============================================================
// Attachment + pasted-text state
// ============================================================

type ImageAttachment = { path: string; dataUrl: string };
type FileAttachment = { path: string; name: string; size: number };
type PastedText = { id: string; content: string; preview: string };

let attachedImages: ImageAttachment[] = [];
let attachedFiles: FileAttachment[] = [];
let pastedTexts: PastedText[] = [];
let pasteSeq = 0;

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|heic|heif|svg)$/i;
function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || IMAGE_EXT_RE.test(file.name);
}
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ============================================================
// Slash-command palette
// ============================================================

type Command = {
  name: string;
  description: string;
  run: () => void | Promise<void>;
};

const COMMANDS: Command[] = [
  {
    name: "/restart",
    description: "Restart the agent daemon",
    run: async () => {
      try {
        await invoke("restart_daemon");
        showToast("Daemon restarted");
        clearAll();
      } catch (e) {
        showError(String(e));
      }
    },
  },
  {
    name: "/clear",
    description: "Clear the conversation",
    run: () => clearAll(),
  },
  {
    name: "/hide",
    description: "Hide the spotlight window",
    run: () => win.hide(),
  },
  {
    name: "/sessions",
    description: "List and resume saved sessions",
    run: () => openSessionPicker(),
  },
  {
    name: "/resume",
    description: "Resume the most recent saved session",
    run: () => resumeMostRecent(),
  },
];

let paletteOpen = false;
let paletteIdx = 0;
let paletteFiltered: Command[] = [];

function updatePalette() {
  const v = composer.value;
  if (v.startsWith("/") && !v.includes("\n")) {
    const q = v.toLowerCase();
    paletteFiltered = COMMANDS.filter((c) => c.name.toLowerCase().startsWith(q));
    if (paletteFiltered.length === 0) {
      hidePalette();
      return;
    }
    paletteOpen = true;
    paletteIdx = Math.min(paletteIdx, paletteFiltered.length - 1);
    renderPalette();
  } else {
    hidePalette();
  }
}

function renderPalette() {
  commandsEl.classList.remove("hidden");
  commandsEl.innerHTML = paletteFiltered
    .map(
      (c, i) =>
        `<div class="cmd${i === paletteIdx ? " selected" : ""}" data-idx="${i}">` +
        `<span class="cmd-name">${escape(c.name)}</span>` +
        `<span class="cmd-desc">${escape(c.description)}</span>` +
        `</div>`,
    )
    .join("");
  fitWindow();
}

function hidePalette() {
  if (!paletteOpen) return;
  paletteOpen = false;
  paletteIdx = 0;
  paletteFiltered = [];
  commandsEl.classList.add("hidden");
  commandsEl.innerHTML = "";
  // If the response is empty, snap back down — the palette grew the window
  // and we don't want a blank dead zone after it closes.
  if (response.classList.contains("empty")) {
    snapToMin();
  } else {
    fitWindow();
  }
}

async function runSelectedCommand() {
  const cmd = paletteFiltered[paletteIdx];
  if (!cmd) return;
  composer.value = "";
  autosizeComposer();
  hidePalette();
  // Slash-palette grew the window; with the palette gone and no chat content
  // arriving, the never-shrink fitWindow rule would leave a blank dead area
  // below the bar. Snap back down unless the command opened an overlay
  // (paste/session picker) that itself wants the room.
  if (response.classList.contains("empty") && !document.querySelector(".paste-overlay")) {
    snapToMin();
  }
  await cmd.run();
  // After commands like /clear that don't add content, snap again — the
  // command may have updated state but not the window size.
  if (response.classList.contains("empty") && !document.querySelector(".paste-overlay")) {
    snapToMin();
  }
}

// ============================================================
// Turn model
// ============================================================

type Turn = {
  id: string;
  query: string;
  pastedTexts: PastedText[];
  images: ImageAttachment[];
  files: FileAttachment[];
  segments: HTMLDivElement[];
  container: HTMLDivElement;
  contentEl: HTMLDivElement;
  typingEl: HTMLDivElement | null;
  fullText: string;
  done: boolean;
  parent?: string; // turn id this is a reply to
  side?: boolean; // rendered as side-chat bubble
};

let turns: Turn[] = [];
let activeTurn: Turn | null = null;
let active = false;
let toastEl: HTMLDivElement | null = null;
let stickToBottom = true;
let turnSeq = 0;

function setActive(running: boolean) {
  active = running;
  statusLine.classList.toggle("active", running);
  composerWrap.classList.toggle("streaming", running);
}

// Daemon reachability indicator. Set to true on socket failure; cleared on the
// next successful stream chunk or completion. The .bar-icon picks up an error
// color via CSS while this is set.
function setDaemonDown(down: boolean) {
  document.body.classList.toggle("daemon-down", down);
}

function setResponseEmpty(empty: boolean) {
  response.classList.toggle("empty", empty);
  bar.classList.toggle("has-response", !empty);
  fitWindow();
}

function newTurnId(): string {
  return `t${++turnSeq}`;
}

function createTurn(opts: {
  query: string;
  pastes: PastedText[];
  images: ImageAttachment[];
  files?: FileAttachment[];
  parent?: string;
  side?: boolean;
}): Turn {
  const files = opts.files ?? [];
  const container = document.createElement("div");
  container.className = "turn";
  if (opts.side) container.classList.add("turn-side");
  if (turns.length > 0 && !opts.side) container.classList.add("turn-divider");

  const queryEl = document.createElement("div");
  queryEl.className = "user-query";
  queryEl.textContent = opts.query || "(no text)";
  container.appendChild(queryEl);

  // Render attachments inline in the user-query block (#6).
  if (opts.images.length > 0) {
    const imgRow = document.createElement("div");
    imgRow.className = "history-images";
    imgRow.innerHTML = opts.images
      .map((img) => `<img class="history-img" src="${escape(img.dataUrl)}" alt="" />`)
      .join("");
    container.appendChild(imgRow);
  }
  if (files.length > 0) {
    const fileRow = document.createElement("div");
    fileRow.className = "history-files";
    fileRow.innerHTML = files
      .map(
        (f) =>
          `<div class="paste-chip file-chip" title="${escape(f.path)}">` +
          `<span class="paste-chip-tag">FILE</span>` +
          `<span class="file-chip-name">${escape(f.name)}</span>` +
          `<span class="paste-chip-meta">${fmtBytes(f.size)}</span>` +
          `</div>`,
      )
      .join("");
    container.appendChild(fileRow);
  }
  if (opts.pastes.length > 0) {
    const pasteRow = document.createElement("div");
    pasteRow.className = "history-pastes";
    pasteRow.innerHTML = opts.pastes
      .map(
        (p, i) =>
          `<details class="history-paste" data-idx="${i}">` +
          `<summary><span class="paste-tag">PASTED</span><span class="paste-meta">${p.content.length} chars</span></summary>` +
          `<pre class="paste-body"></pre>` +
          `</details>`,
      )
      .join("");
    pasteRow.querySelectorAll<HTMLElement>(".history-paste").forEach((el, i) => {
      const pre = el.querySelector(".paste-body") as HTMLPreElement;
      pre.textContent = opts.pastes[i].content;
    });
    container.appendChild(pasteRow);
  }

  const contentEl = document.createElement("div");
  contentEl.className = "turn-content";
  container.appendChild(contentEl);

  // Insertion: side bubbles attach to their parent turn; main turns append
  // to response-inner (the natural-content wrapper used by fitWindow).
  if (opts.side && opts.parent) {
    const parentEl = responseInner.querySelector(`[data-turn-id="${opts.parent}"]`);
    if (parentEl) parentEl.appendChild(container);
    else responseInner.appendChild(container);
  } else {
    responseInner.appendChild(container);
  }

  const id = newTurnId();
  container.dataset.turnId = id;

  return {
    id,
    query: opts.query,
    pastedTexts: opts.pastes,
    images: opts.images,
    files,
    segments: [],
    container,
    contentEl,
    typingEl: null,
    fullText: "",
    done: false,
    parent: opts.parent,
    side: opts.side,
  };
}

function ensureTyping(turn: Turn) {
  if (turn.typingEl) return;
  turn.typingEl = document.createElement("div");
  turn.typingEl.className = "typing";
  turn.typingEl.innerHTML = `<span></span><span></span><span></span>`;
  turn.contentEl.appendChild(turn.typingEl);
}

function removeTyping(turn: Turn) {
  turn.typingEl?.remove();
  turn.typingEl = null;
}

function appendChunk(turn: Turn, text: string) {
  removeTyping(turn);
  turn.fullText += text;
  const last = turn.contentEl.querySelector<HTMLDivElement>(".text-seg:last-child");
  // Coalesce consecutive text into the same segment unless a tool break exists.
  const lastSegmentIsText = turn.contentEl.lastElementChild?.classList.contains("text-seg");
  if (lastSegmentIsText && last) {
    const prev = (last as any)._content as string;
    const merged = (prev || "") + text;
    (last as any)._content = merged;
    last.innerHTML = md.render(merged);
    enhanceCodeBlocks(last);
  } else {
    const el = document.createElement("div");
    el.className = "text-seg";
    (el as any)._content = text;
    el.innerHTML = md.render(text);
    turn.contentEl.appendChild(el);
    turn.segments.push(el);
    enhanceCodeBlocks(el);
  }
}

// Add a copy button to every <pre> code block inside the given container.
// Idempotent — safe to call after each re-render since chunks keep coming
// during streaming. Skip blocks already enhanced.
function enhanceCodeBlocks(root: HTMLElement) {
  const pres = root.querySelectorAll<HTMLPreElement>("pre");
  for (const pre of Array.from(pres)) {
    if (pre.querySelector(".code-copy")) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "code-copy";
    btn.title = "Copy";
    btn.textContent = "Copy";
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const codeEl = pre.querySelector("code");
      const text = (codeEl?.textContent ?? pre.textContent ?? "").replace(/\s+$/, "");
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = "Copied";
        btn.classList.add("copied");
        setTimeout(() => {
          btn.textContent = "Copy";
          btn.classList.remove("copied");
        }, 1200);
      } catch (err) {
        showToast("Copy failed: " + err);
      }
    });
    pre.appendChild(btn);
  }
}

function appendTool(turn: Turn, name: string, label: string) {
  removeTyping(turn);
  const el = document.createElement("div");
  el.className = "tool tool-enter";
  const labelHtml = label
    ? `<span class="tool-sep">·</span><span class="tool-label"></span>`
    : "";
  el.innerHTML = `<span class="tool-arrow">→</span><span class="tool-name"></span>${labelHtml}`;
  (el.querySelector(".tool-name") as HTMLSpanElement).textContent = prettyToolName(name);
  if (label) {
    (el.querySelector(".tool-label") as HTMLSpanElement).textContent = label;
  }
  turn.contentEl.appendChild(el);
  setTimeout(() => el.classList.remove("tool-enter"), 500);
  if (active && turn === activeTurn) ensureTyping(turn);
}

function finalizeTurn(turn: Turn) {
  turn.done = true;
  removeTyping(turn);
  // Reply / Side affordance is no longer rendered as always-on buttons —
  // it appears as a floating popover when the user selects text in a turn.
  saveSession();
}

function clearAll() {
  turns = [];
  activeTurn = null;
  responseInner.innerHTML = "";
  currentClaudeSessionId = null;
  localStorage.removeItem(CURRENT_SESSION_KEY);
  void invoke("start_fresh_session").catch(() => {});
  setResponseEmpty(true);
  snapToMin();
}

function showError(message: string) {
  const turn = activeTurn ?? turns[turns.length - 1];
  const target = turn?.contentEl ?? response;
  if (turn) removeTyping(turn);
  const err = document.createElement("p");
  err.className = "error";
  err.textContent = message;
  target.appendChild(err);
  setResponseEmpty(false);
}

function showToast(text: string) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.className = "toast";
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = text;
  toastEl.classList.add("show");
  setTimeout(() => toastEl?.classList.remove("show"), 1400);
}

// ============================================================
// Sticky-bottom scroll (#7)
// ============================================================

function isAtBottom(): boolean {
  return (
    response.scrollTop + response.clientHeight + STICKY_BOTTOM_TOLERANCE >=
    response.scrollHeight
  );
}

response.addEventListener("scroll", () => {
  // Update stickiness based on user position.
  stickToBottom = isAtBottom();
});

function maybeFollow() {
  if (stickToBottom) {
    response.scrollTop = response.scrollHeight;
  }
}

// ============================================================
// Window sizing (#1)
// ============================================================

// Persisted across app restarts. Whenever the user manually resizes the
// window, this becomes the new canonical height — used as both the open-at
// height for future launches AND the cap for auto-grow during streaming.
const PREFERRED_H_KEY = "spotlight.preferredHeight.v1";
function loadPreferredHeight(): number | null {
  const v = localStorage.getItem(PREFERRED_H_KEY);
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= MIN_HEIGHT ? n : null;
}
function savePreferredHeight(h: number) {
  localStorage.setItem(PREFERRED_H_KEY, String(Math.round(h)));
}

let userMaxHeight: number | null = loadPreferredHeight();
let suppressResizeWatcher = false;
let fitPending = false;
// Debounce persistence so a single drag doesn't write 60×/sec.
let userHeightSaveTimer: number | null = null;

// Cached window geometry — refreshed only on real user resize events.
// fitWindow used to await win.scaleFactor() + win.innerSize() on every fire,
// each a ~5–10ms IPC roundtrip. Multiplied by ResizeObserver firing per
// streamed chunk, that produced a visible per-frame stair-step "slow grow".
// Synchronous fitWindow + cached geometry collapses the whole grow into a
// single setSize call.
let cachedFactor = 2;
let cachedW = 640;
let cachedH = MIN_HEIGHT;

(async () => {
  try {
    cachedFactor = await win.scaleFactor();
    const inner = await win.innerSize();
    cachedW = Math.round(inner.width / cachedFactor);
    cachedH = Math.round(inner.height / cachedFactor);
  } catch {}
})();

window.addEventListener("resize", () => {
  if (suppressResizeWatcher) {
    // Programmatic resize — refresh cache only.
    cachedW = window.innerWidth;
    cachedH = window.innerHeight;
    return;
  }
  cachedW = window.innerWidth;
  cachedH = window.innerHeight;
  if (cachedH > MIN_HEIGHT + 8) {
    userMaxHeight = cachedH;
    // Persist after the user stops dragging (debounced).
    if (userHeightSaveTimer !== null) window.clearTimeout(userHeightSaveTimer);
    userHeightSaveTimer = window.setTimeout(() => {
      if (userMaxHeight != null) savePreferredHeight(userMaxHeight);
    }, 250);
  }
  fitWindow();
});

function fitWindow() {
  if (fitPending) return;
  fitPending = true;
  requestAnimationFrame(() => {
    fitPending = false;

    // Always ensure the bar itself fits — attachments (image thumbs, file
    // chips, PASTED chips) inflate it past the MIN_HEIGHT bar, and without
    // this the textarea ends up below the window edge.
    const barNatural = bar.scrollHeight;
    const statusNatural = statusLine.offsetHeight;
    const barNeeded = barNatural + statusNatural + 4;
    if (barNeeded > cachedH + 1) {
      const target = Math.min(MAX_HEIGHT, barNeeded);
      animateHeightFast(cachedH, target);
      cachedH = target;
    }

    const hasContent = !response.classList.contains("empty") || paletteOpen;
    if (!hasContent) return;

    // Measure natural content via response-inner (NOT response.scrollHeight
    // — .response is flex:1 1 auto and would inflate to the window height,
    // creating a runaway feedback loop).
    const contentH = responseInner.offsetHeight;
    const chrome = bar.offsetHeight + statusLine.offsetHeight + 12;
    const responseAvailable = Math.max(0, cachedH - chrome);
    // Grow the window only when content would overflow the response area —
    // i.e., there's literally no more scroll room left. This means typing
    // into the composer (which inflates the bar and shrinks the response
    // area) won't grow the window unless it actually clips chat content.
    const overflow = Math.max(0, contentH - responseAvailable);
    const paletteOverflow = paletteOpen
      ? Math.max(0, commandsEl.offsetHeight - (cachedH - bar.offsetHeight - 12))
      : 0;
    if (overflow > 0 || paletteOverflow > 0) {
      // userMaxHeight is the cap for chat-content auto-grow, but transient UI
      // (slash palette) needs to fit regardless of the user's preferred
      // canonical size — otherwise typing `/` collapses into a sliver.
      const contentCeiling = userMaxHeight != null
        ? Math.min(MAX_HEIGHT, userMaxHeight)
        : MAX_HEIGHT;
      const wantContent = overflow > 0 ? Math.min(contentCeiling, cachedH + overflow) : 0;
      const wantPalette = paletteOverflow > 0 ? Math.min(MAX_HEIGHT, cachedH + paletteOverflow) : 0;
      const cap = Math.max(wantContent, wantPalette);
      if (cap > cachedH + 1) {
        animateHeightFast(cachedH, cap);
        cachedH = cap;
      }
    }
  });
}

async function snapToMin() {
  try {
    const factor = await win.scaleFactor();
    const inner = await win.innerSize();
    const wLogical = Math.round(inner.width / factor);
    const hLogical = Math.round(inner.height / factor);
    if (hLogical !== MIN_HEIGHT) {
      animateHeight(wLogical, hLogical, MIN_HEIGHT);
    }
  } catch {}
}

// Single shared animation handle — animateHeight and animateHeightFast used
// to maintain separate state and could run concurrently, fighting over cachedH.
// One handle means a new animation always cancels and replaces the prior one.
let activeAnim: number | null = null;
let suppressResizeTimer: number | null = null;

function clearSuppressTimer() {
  if (suppressResizeTimer !== null) {
    window.clearTimeout(suppressResizeTimer);
    suppressResizeTimer = null;
  }
}

function cancelHeightAnim() {
  if (activeAnim !== null) {
    cancelAnimationFrame(activeAnim);
    activeAnim = null;
  }
}

// Fast animated grow used by fitWindow during streaming. Targets resize_height
// (the cocoa setFrame:display:animate:NO path) on each frame so the animation
// is JS-controlled and AppKit doesn't try to layer its own ease on top.
function animateHeightFast(fromH: number, toH: number, duration = 90) {
  cancelHeightAnim();
  clearSuppressTimer();
  const start = performance.now();
  suppressResizeWatcher = true;
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const h = Math.round(fromH + (toH - fromH) * eased);
    cachedH = h;
    invoke("resize_height", { height: h }).catch(() => {});
    if (t < 1) {
      activeAnim = requestAnimationFrame(step);
    } else {
      activeAnim = null;
      cachedH = toH;
      suppressResizeTimer = window.setTimeout(() => {
        suppressResizeWatcher = false;
        suppressResizeTimer = null;
      }, 30);
    }
  };
  activeAnim = requestAnimationFrame(step);
}

function animateHeight(width: number, fromH: number, toH: number, duration = 40) {
  // Always keep cachedH consistent with the actual window — fitWindow uses
  // it as the truth source for "do we have room."
  void width;
  cancelHeightAnim();
  clearSuppressTimer();
  const start = performance.now();
  suppressResizeWatcher = true;
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const h = Math.round(fromH + (toH - fromH) * eased);
    cachedH = h;
    win.setSize(new LogicalSize(width, h)).catch(() => {});
    if (t < 1) {
      activeAnim = requestAnimationFrame(step);
    } else {
      activeAnim = null;
      cachedH = toH;
      suppressResizeTimer = window.setTimeout(() => {
        suppressResizeWatcher = false;
        suppressResizeTimer = null;
      }, 50);
    }
  };
  activeAnim = requestAnimationFrame(step);
}

// ============================================================
// Helpers
// ============================================================

function escape(s: string) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function prettyToolName(raw: string): string {
  const m = raw.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
  if (m) return `${m[1]} · ${m[2]}`;
  return raw;
}

// ============================================================
// Image attachments (#4: raw preview, no filename)
// ============================================================

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

async function attachImage(file: File) {
  try {
    const dataUrl = await fileToDataUrl(file);
    const path = await invoke<string>("save_image", { dataUrl });
    attachedImages.push({ path, dataUrl });
    renderAttachments();
  } catch (e) {
    showToast("Image attach failed: " + e);
  }
}

async function attachFile(file: File) {
  try {
    const dataUrl = await fileToDataUrl(file);
    const path = await invoke<string>("save_file", {
      name: file.name || "file",
      dataUrl,
    });
    attachedFiles.push({ path, name: file.name || "file", size: file.size });
    renderAttachments();
  } catch (e) {
    showToast("File attach failed: " + e);
  }
}

async function attachAny(file: File) {
  if (isImageFile(file)) await attachImage(file);
  else await attachFile(file);
}

function renderAttachments() {
  const hasAny =
    attachedImages.length > 0 ||
    attachedFiles.length > 0 ||
    pastedTexts.length > 0;
  if (!hasAny) {
    attachmentsEl.classList.add("hidden");
    attachmentsEl.innerHTML = "";
    fitWindow();
    autosizeComposer();
    return;
  }
  attachmentsEl.classList.remove("hidden");
  const imageHtml = attachedImages
    .map(
      (img, i) =>
        `<div class="thumb" data-img-idx="${i}">` +
        `<img src="${escape(img.dataUrl)}" alt="" />` +
        `<span class="thumb-x" data-remove-img="${i}">×</span>` +
        `</div>`,
    )
    .join("");
  const fileHtml = attachedFiles
    .map(
      (f, i) =>
        `<div class="paste-chip file-chip" data-file-idx="${i}" title="${escape(f.path)}">` +
        `<span class="paste-chip-tag">FILE</span>` +
        `<span class="file-chip-name">${escape(f.name)}</span>` +
        `<span class="paste-chip-meta">${fmtBytes(f.size)}</span>` +
        `<span class="paste-chip-x" data-remove-file="${i}">×</span>` +
        `</div>`,
    )
    .join("");
  const pasteHtml = pastedTexts
    .map(
      (p, i) =>
        `<div class="paste-chip" data-paste-idx="${i}">` +
        `<span class="paste-chip-tag">PASTED</span>` +
        `<span class="paste-chip-meta">${p.content.length} chars</span>` +
        `<span class="paste-chip-x" data-remove-paste="${i}">×</span>` +
        `</div>`,
    )
    .join("");
  attachmentsEl.innerHTML = imageHtml + fileHtml + pasteHtml;
  fitWindow();
  autosizeComposer();
}

attachmentsEl.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const removeImg = target.dataset.removeImg;
  const removePaste = target.dataset.removePaste;
  const removeFile = target.dataset.removeFile;
  if (removeImg !== undefined) {
    attachedImages.splice(Number(removeImg), 1);
    renderAttachments();
    return;
  }
  if (removeFile !== undefined) {
    attachedFiles.splice(Number(removeFile), 1);
    renderAttachments();
    return;
  }
  if (removePaste !== undefined) {
    pastedTexts.splice(Number(removePaste), 1);
    renderAttachments();
    return;
  }
  // Click chip body → expand inline (toggle a modal-ish editor)
  const chip = target.closest(".paste-chip") as HTMLElement | null;
  if (chip && chip.dataset.pasteIdx) {
    expandPasteChip(Number(chip.dataset.pasteIdx));
  }
});

function expandPasteChip(idx: number) {
  const p = pastedTexts[idx];
  if (!p) return;
  const overlay = document.createElement("div");
  overlay.className = "paste-overlay";
  overlay.innerHTML = `
    <div class="paste-overlay-card">
      <div class="paste-overlay-head">
        <span class="paste-tag">PASTED · ${p.content.length} chars</span>
        <button class="paste-overlay-close" title="Close (Esc)">×</button>
      </div>
      <textarea class="paste-overlay-text" spellcheck="false"></textarea>
      <div class="paste-overlay-foot">
        <button class="paste-overlay-save">Save (⌘↵)</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const ta = overlay.querySelector(".paste-overlay-text") as HTMLTextAreaElement;
  ta.value = p.content;
  ta.focus();
  const save = () => {
    p.content = ta.value;
    renderAttachments();
    close();
  };
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      save();
    }
  };
  document.addEventListener("keydown", onKey, true);
  overlay.querySelector(".paste-overlay-close")!.addEventListener("click", close);
  overlay.querySelector(".paste-overlay-save")!.addEventListener("click", save);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
}

composer.addEventListener("paste", async (e) => {
  const items = Array.from(e.clipboardData?.items ?? []);
  const imgs = items.filter((i) => i.type.startsWith("image/"));
  if (imgs.length > 0) {
    e.preventDefault();
    for (const it of imgs) {
      const file = it.getAsFile();
      if (file) await attachImage(file);
    }
    return;
  }

  // Large pasted text → collapse into a chip (#3).
  const text = e.clipboardData?.getData("text") ?? "";
  if (text.length >= PASTE_CHIP_THRESHOLD) {
    e.preventDefault();
    const id = `p${++pasteSeq}`;
    pastedTexts.push({
      id,
      content: text,
      preview: text.slice(0, 60).replace(/\s+/g, " ") + "…",
    });
    renderAttachments();
  }
  // shorter pastes flow normally
});

document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  const files = Array.from(e.dataTransfer?.files ?? []);
  for (const file of files) {
    await attachAny(file);
  }
});


// ============================================================
// Composer auto-grow (#5)
// ============================================================

// Hidden span used to measure the natural width of whatever's currently
// in (or about to render in) the textarea. Sized once with the composer's
// computed font so measurements match what the textarea would render.
let composerMeasure: HTMLSpanElement | null = null;
function getMeasure(): HTMLSpanElement {
  if (composerMeasure) return composerMeasure;
  const el = document.createElement("span");
  el.style.position = "absolute";
  el.style.visibility = "hidden";
  el.style.whiteSpace = "pre";
  el.style.pointerEvents = "none";
  el.style.top = "-9999px";
  el.style.left = "0";
  const cs = getComputedStyle(composer);
  el.style.font = cs.font;
  el.style.letterSpacing = cs.letterSpacing;
  document.body.appendChild(el);
  composerMeasure = el;
  return el;
}

// Stable floor for composer width — at least as wide as the placeholder
// so the field doesn't visibly shrink the moment the user types the first
// character (which switches measurement from placeholder text to content
// text, producing a jarring jump otherwise).
let composerMinWidth = 140;
function recomputeComposerMin() {
  const measure = getMeasure();
  measure.textContent = composer.placeholder || "Ask Claude…";
  composerMinWidth = Math.max(140, measure.offsetWidth + 28);
}

function sizeComposerWidth() {
  const measure = getMeasure();
  // Measure ONLY the actual content. Placeholder width is baked into
  // composerMinWidth above so an empty field never reports narrower than
  // the "Ask Claude…" hint, and a single-char input never shrinks below it.
  const text = composer.value;
  let widest = 0;
  for (const line of text.split("\n")) {
    measure.textContent = line || " ";
    if (measure.offsetWidth > widest) widest = measure.offsetWidth;
  }
  // Buffer 28px: enough lead time that the next keystroke doesn't wrap
  // before sizeComposerWidth runs (input event fires after the char lands).
  // Smaller buffers produced the visible jitter on each keystroke.
  const target = Math.max(composerMinWidth, widest + 28);
  const wrap = composerWrap.getBoundingClientRect().width;
  composer.style.width =
    Math.min(target, Math.max(composerMinWidth, wrap - 8)) + "px";
}

function autosizeComposer() {
  composer.style.height = "auto";
  const h = Math.min(COMPOSER_MAX_PX, composer.scrollHeight);
  composer.style.height = h + "px";
  // Width tracks content too — narrow textarea = drag area everywhere else.
  sizeComposerWidth();
  // Toggle has-content so CSS can show the caret only when typing.
  composer.classList.toggle("has-content", composer.value.length > 0);
  // Intentionally NOT calling fitWindow — composer growth should expand
  // INSIDE the existing window (eating from the response area), not push the
  // window taller. fitWindow will still grow the window if the resulting
  // shrink of the response area causes content overflow.
  fitWindow();
}

composer.addEventListener("input", () => {
  autosizeComposer();
  updatePalette();
});

// ============================================================
// Send / mid-stream injection (#8)
// ============================================================

function buildPayload(
  query: string,
  pastes: PastedText[],
  imgs: ImageAttachment[],
  files: FileAttachment[],
): string {
  const parts: string[] = [];
  for (const img of imgs) parts.push(`[Image attached: ${img.path}]`);
  for (const f of files) parts.push(`[File attached: ${f.path}] (original name: ${f.name})`);
  for (const p of pastes) {
    parts.push(`[PASTED ${p.content.length} chars]\n${p.content}\n[/PASTED]`);
  }
  if (query) parts.push(query);
  return parts.join("\n\n");
}

function consumeAttachments(): {
  pastes: PastedText[];
  imgs: ImageAttachment[];
  files: FileAttachment[];
} {
  const pastes = pastedTexts;
  const imgs = attachedImages;
  const files = attachedFiles;
  pastedTexts = [];
  attachedImages = [];
  attachedFiles = [];
  renderAttachments();
  return { pastes, imgs, files };
}

async function send(query: string, opts: { sideOf?: string; injectInto?: string } = {}) {
  const trimmed = query.trim();
  if (
    !trimmed &&
    attachedImages.length === 0 &&
    attachedFiles.length === 0 &&
    pastedTexts.length === 0
  )
    return;

  const { pastes, imgs, files } = consumeAttachments();
  let payload = buildPayload(trimmed, pastes, imgs, files);
  // If we just restored a session that had no claude UUID, inject the prior
  // transcript as context on the very first message after restore. One-shot.
  if (pendingResumeContext && !opts.sideOf) {
    payload = `${pendingResumeContext}\n\n---\n\n${payload}`;
    pendingResumeContext = null;
  }
  // If there's a pending inline reply quote, prepend it as context.
  // (Skip the `injectInto` path — that re-quotes the FULL parent message
  // which would double up with the user-selected quote we already prepend.)
  if (pendingReplyQuote && !opts.sideOf && !opts.injectInto) {
    const quoted = pendingReplyQuote.text
      .split("\n")
      .slice(0, 12)
      .map((l) => `> ${l}`)
      .join("\n");
    payload = `Replying to your earlier message:\n${quoted}\n\n---\n\n${payload}`;
    clearReplyQuote();
  }

  // Mid-stream send → inject inline into the live turn (#8).
  // No new turn block is created; the assistant's continuation streams into
  // the same turn beneath an inline "you · …" marker.
  if (active && activeTurn && !opts.sideOf) {
    try {
      const turn = activeTurn;
      // Append any inline images/pasted-text the user attached with this
      // mid-stream injection so they remain visible in scrollback (#6).
      if (imgs.length > 0) {
        const imgRow = document.createElement("div");
        imgRow.className = "history-images inline-injection-imgs";
        imgRow.innerHTML = imgs
          .map((img) => `<img class="history-img" src="${escape(img.dataUrl)}" alt="" />`)
          .join("");
        turn.contentEl.appendChild(imgRow);
      }
      if (files.length > 0) {
        const fileRow = document.createElement("div");
        fileRow.className = "history-files inline-injection-files";
        fileRow.innerHTML = files
          .map(
            (f) =>
              `<div class="paste-chip file-chip" title="${escape(f.path)}">` +
              `<span class="paste-chip-tag">FILE</span>` +
              `<span class="file-chip-name">${escape(f.name)}</span>` +
              `<span class="paste-chip-meta">${fmtBytes(f.size)}</span>` +
              `</div>`,
          )
          .join("");
        turn.contentEl.appendChild(fileRow);
      }
      if (pastes.length > 0) {
        const pasteRow = document.createElement("div");
        pasteRow.className = "history-pastes inline-injection-pastes";
        pasteRow.innerHTML = pastes
          .map(
            (p, i) =>
              `<details class="history-paste" data-idx="${i}">` +
              `<summary><span class="paste-tag">PASTED</span><span class="paste-meta">${p.content.length} chars</span></summary>` +
              `<pre class="paste-body"></pre>` +
              `</details>`,
          )
          .join("");
        pasteRow.querySelectorAll<HTMLElement>(".history-paste").forEach((el, i) => {
          const pre = el.querySelector(".paste-body") as HTMLPreElement;
          pre.textContent = pastes[i].content;
        });
        turn.contentEl.appendChild(pasteRow);
      }
      if (trimmed) {
        const inj = document.createElement("div");
        inj.className = "inline-injection";
        inj.textContent = trimmed;
        turn.contentEl.appendChild(inj);
      }
      // Track the injection on the turn so saved sessions / replies see it.
      turn.fullText += `\n\n[user injected mid-stream]: ${trimmed}\n\n`;
      ensureTyping(turn);
      maybeFollow();

      await invoke("interrupt_query", { query: payload });
      // The existing send_query channel keeps receiving events on the same
      // socket; daemon swapped the underlying claude child. Stream continues
      // into `activeTurn` (unchanged).
    } catch (e) {
      showError(String(e));
      setActive(false);
    }
    return;
  }

  // Side-chat reply (#2 — bubble anchored to parent).
  if (opts.sideOf) {
    const turn = createTurn({
      query: trimmed,
      pastes,
      images: imgs,
      files,
      parent: opts.sideOf,
      side: true,
    });
    turns.push(turn);
    void runQuery(turn, payload);
    return;
  }

  // Inject-reply: prefix the assistant's message we're replying to (#2).
  let finalPayload = payload;
  if (opts.injectInto) {
    const parent = turns.find((t) => t.id === opts.injectInto);
    if (parent && parent.fullText) {
      const quoted = parent.fullText
        .split("\n")
        .slice(0, 8)
        .map((l) => `> ${l}`)
        .join("\n");
      finalPayload = `Replying to your earlier message:\n${quoted}\n\n---\n\n${payload}`;
    }
  }

  const turn = createTurn({
    query: trimmed,
    pastes,
    images: imgs,
    files,
    parent: opts.injectInto,
  });
  turns.push(turn);
  setResponseEmpty(false);
  void runQuery(turn, finalPayload);
}

async function runQuery(turn: Turn, payload: string) {
  setActive(true);
  activeTurn = turn;
  ensureTyping(turn);
  maybeFollow();

  const channel = new Channel<
    | { kind: "chunk"; text: string }
    | { kind: "tool"; name: string; label: string }
    | { kind: "sessionid"; id: string }
    | { kind: "done"; response: string }
    | { kind: "error"; message: string }
    | { kind: "cancelled" }
  >();

  channel.onmessage = (msg) => {
    // Route to whichever turn is currently active (handles interrupt swap).
    const target = activeTurn ?? turn;
    if (msg.kind === "chunk") {
      setDaemonDown(false);
      appendChunk(target, msg.text);
      maybeFollow();
    } else if (msg.kind === "sessionid") {
      // Capture the claude session UUID once per session — pinned for
      // future --resume calls when this saved session gets restored.
      if (!currentClaudeSessionId) {
        currentClaudeSessionId = msg.id;
        saveSession();
      }
    } else if (msg.kind === "tool") {
      appendTool(target, msg.name, msg.label || "");
      maybeFollow();
    } else if (msg.kind === "done") {
      finalizeTurn(target);
      activeTurn = null;
      setActive(false);
    } else if (msg.kind === "cancelled") {
      removeTyping(target);
      const note = document.createElement("div");
      note.className = "stream-note muted";
      note.textContent = "✕ cancelled";
      target.contentEl.appendChild(note);
      finalizeTurn(target);
      activeTurn = null;
      setActive(false);
    } else if (msg.kind === "error") {
      removeTyping(target);
      const err = document.createElement("p");
      err.className = "error";
      err.textContent = msg.message;
      target.contentEl.appendChild(err);
      if (/cannot reach daemon|connect|broken pipe|connection refused/i.test(msg.message)) {
        setDaemonDown(true);
      }
      activeTurn = null;
      setActive(false);
    }
  };

  try {
    await invoke("send_query", { query: payload, onEvent: channel });
  } catch (e) {
    removeTyping(turn);
    const msg = String(e);
    showError(msg);
    if (/cannot reach daemon|connect|broken pipe|connection refused/i.test(msg)) {
      setDaemonDown(true);
    }
    activeTurn = null;
    setActive(false);
  }
}

// ============================================================
// Inline reply UI (#2)
// ============================================================

let openReplyComposer: HTMLDivElement | null = null;

function openReplyFor(turnId: string, mode: "inject" | "side") {
  if (openReplyComposer) openReplyComposer.remove();
  const parent = responseInner.querySelector(
    `[data-turn-id="${turnId}"]`,
  ) as HTMLDivElement | null;
  if (!parent) return;

  const box = document.createElement("div");
  box.className = "reply-composer " + (mode === "side" ? "reply-side" : "reply-inject");
  box.innerHTML = `
    <div class="reply-head">${mode === "side" ? "Side chat" : "Reply"}</div>
    <textarea class="reply-input" rows="2" spellcheck="false" placeholder="${
      mode === "side"
        ? "One-off question, won't disrupt main thread…"
        : "Continue the thread…"
    }"></textarea>
    <div class="reply-actions">
      <button class="reply-cancel">Cancel</button>
      <button class="reply-send">Send</button>
    </div>`;
  parent.appendChild(box);
  openReplyComposer = box;
  const ta = box.querySelector(".reply-input") as HTMLTextAreaElement;
  ta.focus();

  const close = () => {
    box.remove();
    if (openReplyComposer === box) openReplyComposer = null;
  };

  box.querySelector(".reply-cancel")!.addEventListener("click", close);
  box.querySelector(".reply-send")!.addEventListener("click", () => {
    const v = ta.value.trim();
    if (!v) return close();
    close();
    if (mode === "inject") send(v, { injectInto: turnId });
    else send(v, { sideOf: turnId });
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      (box.querySelector(".reply-send") as HTMLButtonElement).click();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });
  fitWindow();
}

// ============================================================
// Selection-driven Reply / Side popover (#2 — Claude Desktop style)
// ============================================================

const selPopover = document.getElementById("sel-popover") as HTMLDivElement;
let selectedTurnId: string | null = null;
let selectedQuote = "";

function findTurnId(node: Node | null): string | null {
  let n: Node | null = node;
  while (n && n.nodeType !== 1) n = n.parentNode;
  let el = n as HTMLElement | null;
  while (el && !el.dataset?.turnId) el = el.parentElement;
  return el?.dataset?.turnId ?? null;
}

function hidePopover() {
  selPopover.classList.add("hidden");
  selectedTurnId = null;
  selectedQuote = "";
}

/** Replace the browser selection with a persistent <span class="quote-highlight">
 * around the selected range, so the visual highlight survives the main window
 * losing focus. surroundContents() refuses when the selection crosses element
 * boundaries — in that case we fall back to extracting and re-inserting. */
function persistSelectionHighlight() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
  clearPersistedHighlights();
  const range = sel.getRangeAt(0);
  try {
    const span = document.createElement("span");
    span.className = "quote-highlight";
    try {
      range.surroundContents(span);
    } catch {
      // Partially-selected nodes — extract the contents and wrap them.
      const frag = range.extractContents();
      span.appendChild(frag);
      range.insertNode(span);
    }
  } catch (err) {
    console.warn("[spotlight] persistSelectionHighlight failed:", err);
  }
  sel.removeAllRanges();
}

function clearPersistedHighlights() {
  for (const el of Array.from(document.querySelectorAll(".quote-highlight"))) {
    const parent = el.parentNode;
    if (!parent) continue;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
    parent.normalize?.();
  }
}

// Drop any persistent highlight as soon as the user starts a fresh selection.
document.addEventListener("mousedown", (e) => {
  // Don't clear if the click is on the popover or in the side bubble itself.
  if ((e.target as HTMLElement).closest(".sel-popover")) return;
  clearPersistedHighlights();
});

function showPopoverForSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    hidePopover();
    return;
  }
  const range = sel.getRangeAt(0);
  const tid =
    findTurnId(range.startContainer) ??
    findTurnId(range.endContainer);
  if (!tid) {
    hidePopover();
    return;
  }
  const text = sel.toString().trim();
  if (!text) {
    hidePopover();
    return;
  }
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    hidePopover();
    return;
  }
  selectedTurnId = tid;
  selectedQuote = text;
  selPopover.classList.remove("hidden");

  // Measure popover so we can clamp inside the viewport.
  const pw = selPopover.offsetWidth || 110;
  const ph = selPopover.offsetHeight || 30;
  const margin = 6;

  // Try above the selection first; if it would go off-screen, place below.
  const above = rect.top - ph - 8;
  const placeAbove = above >= margin;
  const cy = placeAbove ? above : rect.bottom + 8;
  let cx = rect.left + rect.width / 2 - pw / 2;
  cx = Math.max(margin, Math.min(window.innerWidth - pw - margin, cx));
  selPopover.style.left = `${Math.round(cx)}px`;
  selPopover.style.top = `${Math.round(cy)}px`;
  // Override the CSS translate; we already computed final coords.
  selPopover.style.transform = "none";
  selPopover.style.marginTop = "0";
}

// mouseup is more reliable than selectionchange (which fires on every cursor
// blink and often with collapsed selections).
document.addEventListener("mouseup", () => {
  // Defer one frame so the selection is stable.
  requestAnimationFrame(showPopoverForSelection);
});
document.addEventListener("selectionchange", () => {
  // Hide path only — if the selection is gone, drop the popover.
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) hidePopover();
});
document.addEventListener("mousedown", (e) => {
  // Don't hide if the click is on the popover itself (button click).
  if ((e.target as HTMLElement).closest(".sel-popover")) return;
  hidePopover();
});

// Inline reply state: when set, the next send prepends this quote as
// context, like Claude Desktop's "reply to a message" UX.
let pendingReplyQuote: { turnId: string; text: string } | null = null;
const replyChipEl = document.getElementById("reply-quote-chip") as HTMLDivElement;

function showReplyQuote(text: string, turnId: string) {
  pendingReplyQuote = { text, turnId };
  replyChipEl.classList.remove("hidden");
  // Keep DOM simple — just text + X
  const preview = text.length > 220 ? text.slice(0, 220) + "…" : text;
  replyChipEl.textContent = preview;
  const x = document.createElement("span");
  x.className = "reply-quote-chip-x";
  x.textContent = "×";
  x.addEventListener("click", clearReplyQuote);
  replyChipEl.appendChild(x);
  composer.focus();
  fitWindow();
}
function clearReplyQuote() {
  pendingReplyQuote = null;
  replyChipEl.classList.add("hidden");
  replyChipEl.innerHTML = "";
  fitWindow();
}

selPopover.addEventListener("click", async (e) => {
  const btn = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null;
  if (!btn) return;
  const mode = btn.dataset.mode as "inject" | "side";
  if (!selectedTurnId) return;
  const tid = selectedTurnId;
  const quote = selectedQuote;

  // ↩ Reply = inline. Quote shows in the main composer; user types and sends
  // there. No new window.
  if (mode === "inject") {
    hidePopover();
    persistSelectionHighlight();
    showReplyQuote(quote, tid);
    return;
  }

  // Compute desired screen-coords for the new window from the selection's
  // bounding rect. Don't clamp here — Rust handles clamping using NSScreen,
  // which knows the real multi-monitor geometry (window.screen.availLeft/Top
  // are unreliable in WebKit).
  const REPLY_W = 420;
  let popX = 100;
  let popY = 100;
  const sel = window.getSelection();
  // Use Tauri's actual window position (in logical screen coords) — WebKit's
  // window.screenX/Y on macOS frequently returns 0 or stale values for
  // transparent/borderless windows, placing the side bubble far off.
  let originX = window.screenX;
  let originY = window.screenY;
  try {
    const pos = await win.outerPosition();
    const sf = await win.scaleFactor();
    originX = pos.x / sf;
    originY = pos.y / sf;
  } catch {}
  if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
    const r = sel.getRangeAt(0).getBoundingClientRect();
    popX = originX + r.left + r.width / 2 - REPLY_W / 2;
    popY = originY + r.bottom + 8;
  }
  hidePopover();
  // Persist the selection as a styled span so the highlight stays visible
  // even when the main window loses focus to the side/reply window. The
  // browser's inactive-selection rendering otherwise turns the fill into a
  // hollow gray outline.
  persistSelectionHighlight();
  try {
    console.log("[spotlight] opening reply", { mode, tid, popX, popY });
    await invoke("open_reply_window", {
      turnId: tid,
      mode,
      quote,
      screenX: popX,
      screenY: popY,
    });
  } catch (err) {
    console.error("[spotlight] open_reply_window failed:", err);
    showToast("Reply window failed: " + err);
  }
});

// ============================================================
// Open links in system browser (#9)
// ============================================================

document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const a = target.closest("a") as HTMLAnchorElement | null;
  if (!a) return;
  const href = a.getAttribute("href") || "";
  if (!href) return;
  if (href.startsWith("#") || href.startsWith("javascript:")) return;
  e.preventDefault();
  e.stopPropagation();
  invoke("open_external", { url: href }).catch((err) =>
    showToast("Open failed: " + err),
  );
});

// Belt-and-suspenders: prevent any in-window navigation.
window.addEventListener("beforeunload", (e) => {
  e.preventDefault();
  return (e.returnValue = "");
});

// ============================================================
// Keyboard
// ============================================================

composer.addEventListener("keydown", async (e) => {
  if (paletteOpen) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      paletteIdx = (paletteIdx + 1) % paletteFiltered.length;
      renderPalette();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      paletteIdx = (paletteIdx - 1 + paletteFiltered.length) % paletteFiltered.length;
      renderPalette();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const cmd = paletteFiltered[paletteIdx];
      if (cmd) {
        composer.value = cmd.name + " ";
        autosizeComposer();
        updatePalette();
      }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      await runSelectedCommand();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      composer.value = "";
      autosizeComposer();
      hidePalette();
      return;
    }
  }

  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const q = composer.value;
    composer.value = "";
    autosizeComposer();
    if (autoshotEnabled) {
      // Capture happens before send so the screenshot is attached as input.
      // Awaited intentionally — screencapture -x is fast (<100ms) and the
      // user's expectation is "this submit includes a screenshot."
      await captureAndAttachScreenshot();
    }
    send(q);
  } else if (e.key === "Escape") {
    e.preventDefault();
    // Esc only interrupts; never wipes session (#8b).
    if (active) {
      try { await invoke("cancel_query"); } catch {}
      return;
    }
    if (composer.value || attachedImages.length || attachedFiles.length || pastedTexts.length) {
      composer.value = "";
      attachedImages = [];
      attachedFiles = [];
      pastedTexts = [];
      renderAttachments();
      autosizeComposer();
    } else {
      win.hide();
    }
  } else if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    clearAll();
  } else if (e.key === "r" && e.metaKey && e.shiftKey) {
    e.preventDefault();
    try {
      await invoke("restart_daemon");
      showToast("Daemon restarted");
    } catch (err) {
      showToast(String(err));
    }
  }
});

commandsEl.addEventListener("click", async (e) => {
  const target = (e.target as HTMLElement).closest(".cmd") as HTMLElement | null;
  if (!target) return;
  const idx = Number(target.dataset.idx);
  if (Number.isFinite(idx)) {
    paletteIdx = idx;
    await runSelectedCommand();
  }
});

// Click outside the palette dismisses it. (Esc and selecting-an-item are
// already handled by the composer/keydown handler.)
document.addEventListener("mousedown", (e) => {
  if (!paletteOpen) return;
  const t = e.target as HTMLElement;
  if (t.closest(".commands") || t.closest("#composer")) return;
  hidePalette();
});

win.onFocusChanged(({ payload: focused }) => {
  if (!focused) return;
  // Don't steal focus from interactive surfaces — settings inputs, paste
  // overlay textarea, session picker, or an inline reply composer.
  const active = document.activeElement as HTMLElement | null;
  if (active && active !== document.body && active.tagName === "TEXTAREA") return;
  if (active && active.tagName === "INPUT") return;
  if (document.querySelector(".paste-overlay")) return;
  if (settingsPanel && !settingsPanel.classList.contains("hidden")) return;
  composer.focus();
});

document.addEventListener("mousedown", (e) => {
  if (e.metaKey) {
    e.preventDefault();
    win.startDragging();
  }
});

// Drag in non-text areas of the response stream
response.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  const rect = response.getBoundingClientRect();
  if (e.clientX > rect.right - 14) return; // scrollbar
  const target = e.target as HTMLElement;
  if (
    target.closest(".text-seg") ||
    target.closest(".user-query") ||
    target.closest(".error") ||
    target.closest(".reply-composer") ||
    target.closest(".turn-actions") ||
    target.closest(".history-paste") ||
    target.closest(".history-img")
  ) {
    return;
  }
  win.startDragging();
});

const ro = new ResizeObserver(() => {
  fitWindow();
  maybeFollow();
});
ro.observe(response);

// Clear any value WebKit may have restored from a prior page load (Vite HMR
// can persist textarea state across reloads).
composer.value = "";
composer.classList.remove("has-content");
// Force-hide chips that should start invisible — defensive against any path
// (HMR, restored state) that may have stripped the `hidden` class.
replyChipEl?.classList.add("hidden");
attachmentsEl?.classList.add("hidden");
recomputeComposerMin();
composer.focus();
setResponseEmpty(true);
autosizeComposer();
// Open at the user's preferred height (last manually-resized) if they've
// set one; otherwise just the bar. This way streaming can never push the
// window past what the user has explicitly chosen.
if (userMaxHeight != null && userMaxHeight > MIN_HEIGHT) {
  void invoke("resize_height", { height: userMaxHeight }).catch(() => {});
  cachedH = userMaxHeight;
} else {
  snapToMin();
}
// Defer one frame so the bar has measured its natural height, then grow if
// there's already content staged in the composer (text/attachments survived
// from a prior session via window-state plugin) so the textarea isn't
// hidden under the bottom edge.
requestAnimationFrame(() => fitWindow());
void invoke("start_fresh_session").catch(() => {});

const appEl = document.getElementById("app") as HTMLDivElement;
listen("spotlight-shown", () => {
  appEl.classList.remove("appearing");
  void appEl.offsetWidth;
  appEl.classList.add("appearing");
  composer.focus();
  // First open should always be just the bar (min height) — overrides
  // window-state plugin's restored last-size when there's no chat content.
  // But: if there's text in the composer OR attachments staged, keep the
  // window tall enough that those stay visible.
  const hasStaged =
    composer.value.length > 0 ||
    attachedImages.length > 0 ||
    attachedFiles.length > 0 ||
    pastedTexts.length > 0;
  if (response.classList.contains("empty") && !hasStaged) {
    snapToMin();
  } else {
    fitWindow();
  }
});

// ============================================================
// Session save / resume (#10) — local cache via Tauri webview localStorage
// ============================================================

const CURRENT_SESSION_KEY = "spotlight.current.v1";
const LEGACY_SESSION_STORE_KEY = "spotlight.sessions.v1";

type SavedSession = {
  id: string;
  savedAt: number;
  preview: string;
  /** UUID of the underlying claude CLI session. Set once the daemon emits
   * its session_id on the first turn. Used by /resume to call --resume
   * <uuid> instead of --continue, so claude reattaches to the EXACT prior
   * conversation rather than whichever was most recent. */
  claudeSessionId?: string;
  turns: {
    id: string;
    query: string;
    fullText: string;
    pastes: PastedText[];
    images: ImageAttachment[];
    files?: FileAttachment[];
  }[];
};

// Tracks the claude session id for the *current* spotlight session so we can
// persist it into SavedSession on each save.
let currentClaudeSessionId: string | null = null;

// When restoring a saved session that has NO claudeSessionId (e.g. a
// pre-feature snapshot), we can't --resume at the CLI level, so we stash
// the prior transcript here and prepend it to the user's next message.
let pendingResumeContext: string | null = null;

// Session cache lives at ~/Documents/my-agent/spotlight-sessions/sessions.json
// (managed by the Rust read_sessions / write_sessions commands). Shared across
// dev and bundled builds since it doesn't depend on WebKit data partitioning.
let sessionsCache: SavedSession[] | null = null;

async function loadSessions(force = false): Promise<SavedSession[]> {
  if (sessionsCache && !force) return sessionsCache;
  try {
    const raw = await invoke<string>("read_sessions");
    sessionsCache = JSON.parse(raw || "[]");
  } catch (e) {
    console.error("[spotlight] read_sessions failed:", e);
    sessionsCache = [];
  }
  // One-shot migration: import any legacy localStorage cache into the file.
  try {
    const legacy = localStorage.getItem(LEGACY_SESSION_STORE_KEY);
    if (legacy) {
      const parsed: SavedSession[] = JSON.parse(legacy);
      const ids = new Set(sessionsCache!.map((s) => s.id));
      for (const s of parsed) {
        if (!ids.has(s.id)) sessionsCache!.push(s);
      }
      await invoke("write_sessions", {
        json: JSON.stringify(sessionsCache!.slice(0, 30)),
      });
      localStorage.removeItem(LEGACY_SESSION_STORE_KEY);
    }
  } catch {}
  return sessionsCache!;
}

async function writeSessions(list: SavedSession[]) {
  sessionsCache = list.slice(0, 30);
  try {
    await invoke("write_sessions", { json: JSON.stringify(sessionsCache) });
  } catch (e) {
    showToast("Session save failed: " + e);
  }
}

let saveTimer: number | null = null;
function saveSession() {
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    if (turns.length === 0) return;
    const id = localStorage.getItem(CURRENT_SESSION_KEY) || `s${Date.now()}`;
    localStorage.setItem(CURRENT_SESSION_KEY, id);
    // Use the most recent meaningful query as preview — easier to identify a
    // session by where it ended up than where it started. Walk backwards
    // through main-thread turns (skip side bubbles) for the first non-empty
    // query, fall back to the first turn if none found.
    const recent = [...turns]
      .reverse()
      .find((t) => !t.side && t.query.trim().length > 0);
    const preview = ((recent ?? turns[0])?.query || "").slice(0, 80);
    const snapshot: SavedSession = {
      id,
      savedAt: Date.now(),
      preview,
      claudeSessionId: currentClaudeSessionId ?? undefined,
      turns: turns.map((t) => ({
        id: t.id,
        query: t.query,
        fullText: t.fullText,
        pastes: t.pastedTexts,
        images: t.images,
        files: t.files,
      })),
    };
    const all = (await loadSessions()).filter((s) => s.id !== id);
    all.unshift(snapshot);
    await writeSessions(all);
  }, 800);
}

function restoreSession(s: SavedSession) {
  clearAll();
  cancelHeightAnim();
  localStorage.setItem(CURRENT_SESSION_KEY, s.id);

  // Reattach claude's actual conversation state. Two paths:
  //   (1) UUID present  → daemon will use --resume <uuid>, full context.
  //   (2) UUID missing  → fall back to inlining the prior turns as a system
  //       preamble in the user's NEXT query. claude won't have its real
  //       session, but it will have the text history.
  if (s.claudeSessionId) {
    currentClaudeSessionId = s.claudeSessionId;
    void invoke("resume_session", { uuid: s.claudeSessionId }).catch((e) => {
      console.error("[spotlight] resume_session failed:", e);
    });
  } else {
    // Build a preamble from the saved turns. It's stashed in pendingResumeContext
    // and prepended on the very next user message.
    const transcript = s.turns
      .map((t) => `## you\n${t.query}\n\n## assistant\n${t.fullText}`)
      .join("\n\n---\n\n");
    pendingResumeContext =
      `[Restored session — context below was a prior conversation. ` +
      `Treat it as already-said context, not a new instruction.]\n\n` +
      transcript +
      `\n\n[end restored context]`;
    void invoke("start_fresh_session").catch(() => {});
  }
  for (const t of s.turns) {
    const turn = createTurn({
      query: t.query,
      pastes: t.pastes || [],
      images: t.images || [],
      files: t.files || [],
    });
    turns.push(turn);
    if (t.fullText) {
      const el = document.createElement("div");
      el.className = "text-seg";
      (el as any)._content = t.fullText;
      el.innerHTML = md.render(t.fullText);
      turn.contentEl.appendChild(el);
      turn.fullText = t.fullText;
      turn.segments.push(el);
      enhanceCodeBlocks(el);
    }
    finalizeTurn(turn);
  }
  setResponseEmpty(turns.length === 0);
  maybeFollow();
}

async function openSessionPicker() {
  const all = await loadSessions(true);
  console.log("[spotlight] /sessions loaded", all.length, "entries");
  if (all.length === 0) {
    showToast("No saved sessions");
    return;
  }
  // Grow the window so the picker card has room. snapToMin (from hidePalette)
  // may still be animating down — cancel any in-flight resize animation so
  // ours wins, then jump straight to the picker height.
  cancelHeightAnim();
  const wantedH = 480;
  suppressResizeWatcher = true;
  cachedH = wantedH;
  void invoke("resize_height", { height: wantedH }).catch(() => {});
  setTimeout(() => { suppressResizeWatcher = false; }, 30);
  const overlay = document.createElement("div");
  overlay.className = "paste-overlay";
  overlay.innerHTML = `
    <div class="paste-overlay-card session-picker">
      <div class="paste-overlay-head">
        <span class="paste-tag">SESSIONS</span>
        <button class="paste-overlay-close">×</button>
      </div>
      <div class="session-list"></div>
    </div>`;
  const list = overlay.querySelector(".session-list") as HTMLDivElement;
  list.innerHTML = all
    .map(
      (s) =>
        `<div class="session-row" data-id="${escape(s.id)}">` +
        `<div class="session-preview">${escape(s.preview || "(empty)")}</div>` +
        `<div class="session-meta">${new Date(s.savedAt).toLocaleString()} · ${s.turns.length} turn${s.turns.length === 1 ? "" : "s"}</div>` +
        `</div>`,
    )
    .join("");
  document.body.appendChild(overlay);
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener("keydown", onKey, true);
  overlay.querySelector(".paste-overlay-close")!.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  list.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest(".session-row") as HTMLElement | null;
    if (!row) return;
    const sess = all.find((s) => s.id === row.dataset.id);
    if (sess) restoreSession(sess);
    close();
  });
}

async function resumeMostRecent() {
  const all = await loadSessions(true);
  if (all.length === 0) {
    showToast("No saved sessions");
    return;
  }
  restoreSession(all[0]);
}

// quiet unused-import warning if convertFileSrc isn't used
void convertFileSrc;
