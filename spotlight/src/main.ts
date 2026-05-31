import { invoke, Channel, convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import MarkdownIt from "markdown-it";
// @ts-ignore — no published types
import mdKatex from "@vscode/markdown-it-katex";
import "katex/dist/katex.min.css";
// @ts-ignore — types ship in dist but editor resolution can lag
import { setLiquidGlassEffect } from "tauri-plugin-liquid-glass-api";

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
const app = document.getElementById("app") as HTMLDivElement | null;
const statusLine = document.getElementById("status") as HTMLDivElement;
const commandsEl = document.getElementById("commands") as HTMLDivElement;
const attachmentsEl = document.getElementById("attachments") as HTMLDivElement;
const win = getCurrentWindow();

// Turn on native macOS Liquid Glass behind the transparent webview. This is the
// real frost — CSS backdrop-filter can't blur the desktop through a transparent
// window, so #app only paints the tint/rim on top of this layer. cornerRadius
// matches --radius (8px). Safe no-op on unsupported platforms; wrapped so a
// failure never blocks app boot.
setLiquidGlassEffect({ cornerRadius: 8 }).catch((e: unknown) =>
  console.warn("[spotlight] liquid glass unavailable:", e),
);

const pinBtn = document.getElementById("pin-btn") as HTMLButtonElement | null;
const recordBtn = document.getElementById("record-btn") as HTMLButtonElement | null;
const autoshotBtn = document.getElementById("autoshot-btn") as HTMLButtonElement | null;
const sessionsBtn = document.getElementById("sessions-btn") as HTMLButtonElement | null;
const sessionsBadge = document.getElementById("sessions-badge") as HTMLSpanElement | null;
const settingsBtn = document.getElementById("settings-btn") as HTMLButtonElement | null;
const settingsPanel = document.getElementById("settings-panel") as HTMLDivElement | null;
const settingsCloseBtn = document.getElementById("settings-close") as HTMLButtonElement | null;
const actionsBtn = document.getElementById("actions-btn") as HTMLButtonElement | null;
const actionsBadge = document.getElementById("actions-badge") as HTMLSpanElement | null;
const actionsMenu = document.getElementById("actions-menu") as HTMLDivElement | null;

let pinned = false;
let recording = false;
let autoshotEnabled = false;

pinBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  void togglePin();
});

sessionsBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  void openSessionsPanel();
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

// ============================================================
// Actions kebab menu — collapses pin/record/autoshot/sessions/settings
// into a single dropdown. The five buttons keep their IDs (handlers above
// are unchanged); we only toggle the menu's visibility around them.
// ============================================================
actionsBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  toggleActionsMenu();
});
// Close after a row is chosen. Capture phase: the row handlers call
// stopPropagation, so a bubble listener here would never fire.
actionsMenu?.addEventListener(
  "click",
  (e) => {
    if ((e.target as HTMLElement).closest(".actions-row")) closeActionsMenu();
  },
  true,
);
// Outside click closes the menu.
document.addEventListener("click", (e) => {
  if (!actionsMenu || actionsMenu.classList.contains("hidden")) return;
  const t = e.target as Node;
  if (actionsMenu.contains(t) || actionsBtn?.contains(t)) return;
  closeActionsMenu();
});
// Esc closes the menu (not the window) while it's open.
document.addEventListener(
  "keydown",
  (e) => {
    if (
      e.key === "Escape" &&
      actionsMenu &&
      !actionsMenu.classList.contains("hidden")
    ) {
      e.preventDefault();
      e.stopPropagation();
      closeActionsMenu();
    }
  },
  true,
);

function toggleActionsMenu() {
  if (!actionsMenu) return;
  if (actionsMenu.classList.contains("hidden")) openActionsMenu();
  else closeActionsMenu();
}
function openActionsMenu() {
  if (!actionsMenu) return;
  actionsMenu.classList.remove("hidden");
  actionsBtn?.classList.add("open");
  actionsBtn?.setAttribute("aria-expanded", "true");
  const idle =
    (settingsPanel?.classList.contains("hidden") ?? true) &&
    response.classList.contains("empty");
  const needed = bar.offsetHeight + 196;
  if (idle) {
    // Float the menu over the bar: keep the bar bar-sized, make the rest of the
    // window transparent so no tall glass box appears below the bar.
    app?.classList.add("menu-float");
    invoke("resize_height", { height: Math.min(MAX_HEIGHT, needed) }).catch(() => {});
  } else {
    // A conversation/settings already fills the window — overlay, grow only if
    // the menu would be clipped (never shrink existing content).
    const target = Math.min(MAX_HEIGHT, Math.max(window.innerHeight, needed));
    invoke("resize_height", { height: target }).catch(() => {});
  }
}
function closeActionsMenu() {
  if (!actionsMenu) return;
  actionsMenu.classList.add("hidden");
  actionsBtn?.classList.remove("open");
  actionsBtn?.setAttribute("aria-expanded", "false");
  app?.classList.remove("menu-float");
  const settingsHidden = settingsPanel?.classList.contains("hidden") ?? true;
  if (settingsHidden && response.classList.contains("empty")) snapToMin();
  else if (settingsHidden) fitWindow();
  requestGlassRepaint();
}

// ============================================================
// backdrop-filter repaint fix
// WebKit re-samples a backdrop-filter's backdrop lazily and intermittently
// leaves it STALE after the window resizes — the glass goes flat / shows sharp
// unblurred content through it. Forcing the affected layers to drop and
// re-apply their filter once the resize settles makes WebKit re-sample.
// ============================================================
let glassRepaintTimer: number | undefined;
function requestGlassRepaint() {
  if (glassRepaintTimer) clearTimeout(glassRepaintTimer);
  glassRepaintTimer = window.setTimeout(() => {
    const els = [
      app,
      bar,
      actionsMenu,
      document.getElementById("commands"),
      document.getElementById("reply-app"),
    ].filter(Boolean) as HTMLElement[];
    for (const el of els) {
      el.style.backdropFilter = "none";
      (el.style as unknown as { webkitBackdropFilter: string }).webkitBackdropFilter = "none";
    }
    requestAnimationFrame(() => {
      for (const el of els) {
        el.style.backdropFilter = "";
        (el.style as unknown as { webkitBackdropFilter: string }).webkitBackdropFilter = "";
      }
    });
  }, 45);
}
// Any window resize (programmatic resize_height, content growth, etc.) can
// strand the blur — re-sample whenever the OS reports the window resized.
void win.onResized(() => requestGlassRepaint());

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
  // Repaint host/client sections — they may have been written at startup
  // before their DOM was queryable, or another device may have changed them.
  try { paintHostUI(); paintClientUI(); void loadNetworkInfo(); } catch {}
  // Grow the window enough to show the panel comfortably.
  const target = Math.min(MAX_HEIGHT, Math.max(440, bar.offsetHeight + 420));
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
    if (parsed?.host && typeof parsed.host === "object") {
      hostConfig = { ...hostConfig, ...parsed.host };
    }
    if (parsed?.client && typeof parsed.client === "object") {
      clientConfig = { ...clientConfig, ...parsed.client };
    }
    if (typeof parsed?.model === "string") {
      currentModel = parsed.model;
    }
  } catch (err) {
    console.warn("read_settings failed", err);
  }
  await registerAllHotkeys();
  await applyHostConfig({ silent: true });
  await applyClientConfig({ silent: true });
  // Push the persisted model to the daemon so it survives daemon restarts —
  // the daemon holds the active model in memory only.
  if (currentModel) {
    void invoke("set_model", { model: currentModel }).catch((e) =>
      console.warn("set_model failed", e),
    );
  }
}
void loadSettingsAtStartup();

// ============================================================
// Host + Client (Tailscale-reachable) settings
// ============================================================

type HostConfig = { enabled: boolean; port: number; token: string };
type ClientConfig = { enabled: boolean; host: string; port: number; token: string };

let hostConfig: HostConfig = { enabled: false, port: 47330, token: "" };
let clientConfig: ClientConfig = { enabled: false, host: "", port: 47330, token: "" };

// Selected claude model. "" = CLI default. Persisted in settings.json under
// `model` and pushed to the daemon (which adds --model) on startup + on change.
type ModelChoice = { id: string; label: string; note: string };
const MODELS: ModelChoice[] = [
  { id: "", label: "Default", note: "Use the claude CLI's configured model" },
  { id: "opus", label: "Opus 4.8", note: "Most capable, slower" },
  { id: "sonnet", label: "Sonnet 4.6", note: "Balanced speed and capability" },
  { id: "haiku", label: "Haiku 4.5", note: "Fastest, lightest" },
];
let currentModel = "";

function modelLabel(id: string): string {
  return MODELS.find((m) => m.id === id)?.label ?? id ?? "Default";
}

/** Re-send the active model to the daemon after a restart, retrying while the
 *  socket comes back up. */
async function repushModelAfterRestart() {
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 400));
    try {
      await invoke("set_model", { model: currentModel });
      return;
    } catch {
      /* socket not ready yet — retry */
    }
  }
}

/** Persist the model into settings.json (preserving other keys). */
async function persistModel(id: string) {
  try {
    const raw = await invoke<string>("read_settings");
    const parsed = JSON.parse(raw || "{}");
    parsed.model = id;
    await invoke("write_settings", { json: JSON.stringify(parsed, null, 2) });
  } catch (e) {
    console.warn("persist model failed", e);
  }
}

const hostToggle = document.getElementById("host-toggle") as HTMLInputElement | null;
const hostPortEl = document.getElementById("host-port") as HTMLInputElement | null;
const hostTokenEl = document.getElementById("host-token") as HTMLInputElement | null;
const hostTokenRegen = document.getElementById("host-token-regen") as HTMLButtonElement | null;
const hostTokenCopy = document.getElementById("host-token-copy") as HTMLButtonElement | null;
const hostShareRow = document.getElementById("host-share-row") as HTMLDivElement | null;
const hostShareUrl = document.getElementById("host-share-url") as HTMLInputElement | null;
const hostShareCopy = document.getElementById("host-share-copy") as HTMLButtonElement | null;
const hostStatusEl = document.getElementById("host-status") as HTMLDivElement | null;

const clientToggle = document.getElementById("client-toggle") as HTMLInputElement | null;
const clientHostEl = document.getElementById("client-host") as HTMLInputElement | null;
const clientPortEl = document.getElementById("client-port") as HTMLInputElement | null;
const clientTokenEl = document.getElementById("client-token") as HTMLInputElement | null;
const clientTokenPaste = document.getElementById("client-token-paste") as HTMLButtonElement | null;
const clientStatusEl = document.getElementById("client-status") as HTMLDivElement | null;

let tailscaleInfo: { hostname: string; tailscaleIp?: string; tailscaleHost?: string } | null = null;

function paintHostUI() {
  if (!hostToggle) return;
  hostToggle.checked = hostConfig.enabled;
  if (hostPortEl) hostPortEl.value = String(hostConfig.port);
  if (hostTokenEl) hostTokenEl.value = hostConfig.token;
  updateHostStatus();
  updateShareUrl();
  const label = hostToggle.parentElement?.querySelector(".net-toggle-label");
  if (label) label.textContent = hostConfig.enabled ? "On" : "Off";
}

function paintClientUI() {
  if (!clientToggle) return;
  clientToggle.checked = clientConfig.enabled;
  if (clientHostEl) clientHostEl.value = clientConfig.host;
  if (clientPortEl) clientPortEl.value = String(clientConfig.port);
  if (clientTokenEl) clientTokenEl.value = clientConfig.token;
  updateClientStatus();
  const label = clientToggle.parentElement?.querySelector(".net-toggle-label");
  if (label) label.textContent = clientConfig.enabled ? "On" : "Off";
}

function updateHostStatus() {
  if (!hostStatusEl) return;
  if (!hostConfig.enabled) {
    hostStatusEl.textContent = "Stopped";
    hostStatusEl.classList.remove("ok", "warn");
    return;
  }
  const addr = preferredHostAddress();
  hostStatusEl.textContent = addr
    ? `Listening on ${addr}:${hostConfig.port}`
    : `Listening on 0.0.0.0:${hostConfig.port}`;
  hostStatusEl.classList.add("ok");
  hostStatusEl.classList.remove("warn");
}

function updateClientStatus() {
  if (!clientStatusEl) return;
  if (!clientConfig.enabled) {
    clientStatusEl.textContent = "Local daemon";
    clientStatusEl.classList.remove("ok", "warn");
    return;
  }
  clientStatusEl.textContent = `Routing to ${clientConfig.host}:${clientConfig.port}`;
  clientStatusEl.classList.add("ok");
}

function preferredHostAddress(): string {
  return (
    tailscaleInfo?.tailscaleHost ||
    tailscaleInfo?.tailscaleIp ||
    tailscaleInfo?.hostname ||
    ""
  );
}

function updateShareUrl() {
  if (!hostShareRow || !hostShareUrl) return;
  const addr = preferredHostAddress();
  if (!hostConfig.enabled || !addr || !hostConfig.token) {
    hostShareRow.classList.add("hidden");
    return;
  }
  hostShareRow.classList.remove("hidden");
  hostShareUrl.value = `spotlight://${addr}:${hostConfig.port}?token=${encodeURIComponent(hostConfig.token)}`;
}

async function persistNetSettings() {
  try {
    const raw = await invoke<string>("read_settings");
    const parsed = JSON.parse(raw || "{}");
    parsed.host = hostConfig;
    parsed.client = clientConfig;
    parsed.hotkeys = parsed.hotkeys ?? hotkeys;
    await invoke("write_settings", { json: JSON.stringify(parsed, null, 2) });
  } catch (err) {
    console.error("persistNetSettings failed", err);
  }
}

async function ensureHostToken(): Promise<string> {
  if (hostConfig.token) return hostConfig.token;
  try {
    const t = await invoke<string>("generate_token");
    hostConfig.token = t;
    return t;
  } catch (err) {
    console.error("generate_token failed", err);
    return "";
  }
}

async function applyHostConfig(opts: { silent?: boolean } = {}) {
  if (hostConfig.enabled) {
    await ensureHostToken();
  }
  try {
    const status = await invoke<{ running: boolean; port: number }>("set_host_mode", {
      enabled: hostConfig.enabled,
      port: hostConfig.port,
      token: hostConfig.token,
    });
    if (!opts.silent) {
      showToast(status.running ? `Host on :${status.port}` : "Host stopped");
    }
  } catch (err) {
    console.error("set_host_mode failed", err);
    if (!opts.silent) showToast("Host error: " + err);
    hostConfig.enabled = false;
  }
  paintHostUI();
}

async function applyClientConfig(opts: { silent?: boolean } = {}) {
  try {
    await invoke("set_client_mode", {
      enabled: clientConfig.enabled,
      host: clientConfig.host,
      port: clientConfig.port,
      token: clientConfig.token,
    });
    if (!opts.silent) {
      showToast(
        clientConfig.enabled
          ? `Client → ${clientConfig.host}:${clientConfig.port}`
          : "Client off",
      );
    }
  } catch (err) {
    console.error("set_client_mode failed", err);
    if (!opts.silent) showToast("Client error: " + err);
    clientConfig.enabled = false;
  }
  paintClientUI();
}

async function loadNetworkInfo() {
  try {
    tailscaleInfo = await invoke("network_info");
  } catch (err) {
    console.warn("network_info failed", err);
  }
  updateHostStatus();
  updateShareUrl();
}
void loadNetworkInfo();

// --- Host UI events
hostToggle?.addEventListener("change", async () => {
  hostConfig.enabled = !!hostToggle.checked;
  if (hostConfig.enabled) await ensureHostToken();
  await persistNetSettings();
  await applyHostConfig();
});
hostPortEl?.addEventListener("change", async () => {
  const n = Number(hostPortEl.value);
  if (!Number.isFinite(n) || n < 1024 || n > 65535) {
    showToast("Port must be 1024–65535");
    hostPortEl.value = String(hostConfig.port);
    return;
  }
  hostConfig.port = Math.round(n);
  await persistNetSettings();
  if (hostConfig.enabled) await applyHostConfig();
  else paintHostUI();
});
hostTokenEl?.addEventListener("change", async () => {
  hostConfig.token = hostTokenEl.value.trim();
  await persistNetSettings();
  if (hostConfig.enabled) await applyHostConfig();
  else paintHostUI();
});
hostTokenRegen?.addEventListener("click", async () => {
  hostConfig.token = "";
  await ensureHostToken();
  await persistNetSettings();
  if (hostConfig.enabled) await applyHostConfig();
  else paintHostUI();
  showToast("New token generated");
});
hostTokenCopy?.addEventListener("click", async () => {
  if (!hostConfig.token) {
    showToast("No token yet");
    return;
  }
  try {
    await navigator.clipboard.writeText(hostConfig.token);
    showToast("Token copied");
  } catch {
    showToast("Copy failed");
  }
});
hostShareCopy?.addEventListener("click", async () => {
  if (!hostShareUrl?.value) return;
  try {
    await navigator.clipboard.writeText(hostShareUrl.value);
    showToast("URL copied");
  } catch {
    showToast("Copy failed");
  }
});

// --- Client UI events
clientToggle?.addEventListener("change", async () => {
  clientConfig.enabled = !!clientToggle.checked;
  if (clientConfig.enabled && (!clientConfig.host || !clientConfig.token)) {
    showToast("Set host + token first");
    clientConfig.enabled = false;
    clientToggle.checked = false;
    return;
  }
  await persistNetSettings();
  await applyClientConfig();
});
clientHostEl?.addEventListener("change", async () => {
  clientConfig.host = clientHostEl.value.trim();
  await persistNetSettings();
  if (clientConfig.enabled) await applyClientConfig();
  else paintClientUI();
});
clientPortEl?.addEventListener("change", async () => {
  const n = Number(clientPortEl.value);
  if (!Number.isFinite(n) || n < 1024 || n > 65535) {
    showToast("Port must be 1024–65535");
    clientPortEl.value = String(clientConfig.port);
    return;
  }
  clientConfig.port = Math.round(n);
  await persistNetSettings();
  if (clientConfig.enabled) await applyClientConfig();
  else paintClientUI();
});
clientTokenEl?.addEventListener("change", async () => {
  clientConfig.token = clientTokenEl.value.trim();
  await persistNetSettings();
  if (clientConfig.enabled) await applyClientConfig();
  else paintClientUI();
});
// Paste a host's share URL (spotlight://host:port?token=…) to fill all three fields.
clientTokenPaste?.addEventListener("click", async () => {
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch {
    showToast("Clipboard read failed");
    return;
  }
  text = text.trim();
  if (!text) {
    showToast("Clipboard empty");
    return;
  }
  const parsed = parseShareUrl(text);
  if (!parsed) {
    showToast("Not a share URL");
    return;
  }
  clientConfig.host = parsed.host;
  clientConfig.port = parsed.port;
  clientConfig.token = parsed.token;
  await persistNetSettings();
  paintClientUI();
  showToast(`Parsed ${parsed.host}:${parsed.port}`);
});

function parseShareUrl(s: string): { host: string; port: number; token: string } | null {
  // Accept spotlight://host:port?token=...
  const m = s.match(/^spotlight:\/\/([^:/?]+):(\d+)(?:\/?\?token=([^&\s]+))?$/);
  if (!m) return null;
  const port = Number(m[2]);
  if (!Number.isFinite(port)) return null;
  return {
    host: m[1],
    port,
    token: decodeURIComponent(m[3] ?? ""),
  };
}

// ============================================================
// Attachment + pasted-text state
// ============================================================

type ImageAttachment = { path: string; dataUrl: string };

// Resolve an image's <img src>. Freshly-attached images carry an inline
// dataUrl; restored history images have it trimmed (to keep sessions.json
// small) and instead reference the file on disk, served via Tauri's asset
// protocol from `path`.
function imgSrc(img: ImageAttachment): string {
  if (img.dataUrl) return img.dataUrl;
  if (img.path) {
    try { return convertFileSrc(img.path); } catch { return ""; }
  }
  return "";
}
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
        // Daemon holds the active model in memory only — re-push once the
        // socket is back up (launchctl restart takes a beat).
        if (currentModel) void repushModelAfterRestart();
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
  {
    name: "/model",
    description: "Switch the model claude runs",
    run: () => openModelPicker(),
  },
  {
    name: "/usage",
    description: "Show cost and token usage",
    run: () => openUsagePanel(),
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

// ============================================================
// Workspaces — multiple parallel claude conversations ("tabs")
//
// Each workspace is one claude conversation, identified to the daemon by a
// `tabId` so its child process runs independently of the others. Only one
// workspace is mounted in the DOM at a time; the rest keep their rendered
// turn nodes detached in `dom` so switching back is instant and live streams
// into a hidden workspace keep updating its (off-screen) nodes.
//
// The module globals `turns` / `activeTurn` / `currentClaudeSessionId` /
// `active` mirror the *currently mounted* workspace. switchWorkspace() copies
// them out to the outgoing workspace and loads the incoming one's values in.
// Streaming callbacks capture their owning workspace explicitly (not the
// globals) so a background query routes to the right place.
// ============================================================
type Workspace = {
  tabId: string;                 // daemon routing id ("default" or "tab-N")
  localId: string;               // sessions.json persistence id
  title: string;
  turns: Turn[];
  claudeSessionId: string | null;
  activeTurn: Turn | null;
  active: boolean;
  scrollTop: number;
  dom: Node[];                   // detached responseInner children while hidden
};

let wsSeq = 0;
function newLocalId(): string {
  return `s${Date.now()}_${++wsSeq}`;
}

function makeWorkspace(opts: { tabId: string; localId?: string; title?: string; claudeSessionId?: string | null }): Workspace {
  return {
    tabId: opts.tabId,
    localId: opts.localId ?? newLocalId(),
    title: opts.title ?? "New session",
    turns: [],
    claudeSessionId: opts.claudeSessionId ?? null,
    activeTurn: null,
    active: false,
    scrollTop: 0,
    dom: [],
  };
}

let activeWs: Workspace = makeWorkspace({ tabId: "default" });
const workspaces: Workspace[] = [activeWs];
// The default workspace shares the global turns array as its backing store.
activeWs.turns = turns;

const OPEN_WS_KEY = "spotlight.openWs.v1";

/** Copy the mounted globals back into the active workspace record. */
function syncActiveWorkspace() {
  activeWs.turns = turns;
  activeWs.activeTurn = activeTurn;
  activeWs.claudeSessionId = currentClaudeSessionId;
  activeWs.active = active;
  activeWs.scrollTop = response.scrollTop;
}

/** Mount a workspace: its turns become the globals and its nodes the DOM.
 *  Does NOT save the currently-mounted one — callers handle that. */
function loadWorkspace(ws: Workspace) {
  activeWs = ws;
  turns = ws.turns;
  activeTurn = ws.activeTurn;
  currentClaudeSessionId = ws.claudeSessionId;
  setActive(ws.active);
  responseInner.replaceChildren(...ws.dom);
  ws.dom = [];
  localStorage.setItem(CURRENT_SESSION_KEY, ws.localId);
  setResponseEmpty(turns.length === 0);
  updateSessionsBadge();
  const top = ws.scrollTop;
  requestAnimationFrame(() => {
    response.scrollTop = top;
  });
}

function switchWorkspace(target: Workspace) {
  if (target === activeWs) return;
  // Save the mounted workspace, detach its DOM (kept by reference).
  syncActiveWorkspace();
  activeWs.dom = Array.from(responseInner.childNodes);
  responseInner.replaceChildren();
  loadWorkspace(target);
  persistOpenWorkspaces();
}

async function openWorkspace() {
  let tabId: string;
  try {
    tabId = await invoke<string>("new_tab");
  } catch {
    tabId = `tab-local-${Date.now()}`;
  }
  const ws = makeWorkspace({ tabId });
  workspaces.push(ws);
  switchWorkspace(ws);
  void invoke("start_fresh_session", { tabId }).catch(() => {});
  composer.focus();
  persistOpenWorkspaces();
}

async function closeWorkspace(ws: Workspace) {
  void invoke("close_tab", { tabId: ws.tabId }).catch(() => {});
  const wasActive = ws === activeWs;
  const idx = workspaces.indexOf(ws);
  if (idx >= 0) workspaces.splice(idx, 1);
  if (wasActive) {
    if (workspaces.length === 0) {
      // Recreate a blank default so there's always at least one workspace.
      const fresh = makeWorkspace({ tabId: "default" });
      workspaces.push(fresh);
      turns = [];
      activeTurn = null;
      currentClaudeSessionId = null;
      loadWorkspace(fresh);
      void invoke("start_fresh_session", { tabId: "default" }).catch(() => {});
    } else {
      const next = workspaces[Math.min(idx, workspaces.length - 1)];
      loadWorkspace(next);
    }
  }
  persistOpenWorkspaces();
}

function updateSessionsBadge() {
  if (!sessionsBtn) return;
  const n = workspaces.length;
  sessionsBtn.classList.toggle("multi", n > 1);
  const anyStreaming = workspaces.some((w) => (w === activeWs ? active : w.active));
  sessionsBtn.classList.toggle("streaming", anyStreaming);
  if (sessionsBadge) sessionsBadge.textContent = n > 1 ? String(n) : "";
  // Mirror session count + streaming onto the collapsed kebab trigger.
  actionsBtn?.classList.toggle("multi", n > 1);
  actionsBtn?.classList.toggle("streaming", anyStreaming);
  if (actionsBadge) actionsBadge.textContent = n > 1 ? String(n) : "";
}

function persistOpenWorkspaces() {
  syncActiveWorkspace();
  const list = workspaces.map((w) => ({
    localId: w.localId,
    claudeSessionId: w.claudeSessionId,
    title: w.title,
  }));
  try {
    localStorage.setItem(OPEN_WS_KEY, JSON.stringify(list));
  } catch {}
}

// Restore the set of open workspaces persisted from a prior run. Falls back to
// a single fresh default if nothing is persisted or anything goes wrong.
async function initWorkspaces() {
  let saved: { localId: string; claudeSessionId: string | null; title: string }[] = [];
  try {
    saved = JSON.parse(localStorage.getItem(OPEN_WS_KEY) || "[]");
  } catch {}

  if (!Array.isArray(saved) || saved.length === 0) {
    activeWs.localId = localStorage.getItem(CURRENT_SESSION_KEY) || activeWs.localId;
    void invoke("start_fresh_session", { tabId: "default" }).catch(() => {});
    updateSessionsBadge();
    return;
  }

  try {
    const all = await loadSessions(true);
    for (let i = 0; i < saved.length; i++) {
      const rec = saved[i];
      const snap = all.find((s) => s.id === rec.localId);
      if (i === 0) {
        // Reuse the pre-created default workspace + "default" tab.
        activeWs.localId = rec.localId;
        activeWs.title = rec.title || "Session";
        activeWs.claudeSessionId = rec.claudeSessionId ?? null;
        currentClaudeSessionId = activeWs.claudeSessionId;
        localStorage.setItem(CURRENT_SESSION_KEY, rec.localId);
        if (snap) {
          rebuildTurnsFromSaved(snap);
          armResume(snap, "default");
        } else {
          void invoke("start_fresh_session", { tabId: "default" }).catch(() => {});
        }
        syncActiveWorkspace();
      } else {
        let tabId: string;
        try {
          tabId = await invoke<string>("new_tab");
        } catch {
          tabId = `tab-local-${Date.now()}-${i}`;
        }
        const ws = makeWorkspace({
          tabId,
          localId: rec.localId,
          title: rec.title || "Session",
          claudeSessionId: rec.claudeSessionId ?? null,
        });
        workspaces.push(ws);
        switchWorkspace(ws);
        if (snap) {
          rebuildTurnsFromSaved(snap);
          armResume(snap, tabId);
        } else {
          void invoke("start_fresh_session", { tabId }).catch(() => {});
        }
        syncActiveWorkspace();
      }
    }
    // Return to the first workspace as the mounted one.
    if (workspaces[0]) switchWorkspace(workspaces[0]);
  } catch (e) {
    console.error("[spotlight] initWorkspaces failed:", e);
    void invoke("start_fresh_session", { tabId: "default" }).catch(() => {});
  }
  updateSessionsBadge();
  fitWindow();
}

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
      .map((img) => `<img class="history-img" src="${escape(imgSrc(img))}" alt="" />`)
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

type QuestionOption = { label: string; description?: string };
type QuestionDef = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: QuestionOption[];
};

// Render an AskUserQuestion prompt as an interactive picker. The model's turn is
// parked in the daemon until we POST the answer back via send_answer; until then
// the card is the only actionable surface. answers is keyed by exact question
// text -> chosen label(s) (multi-select joins with ", "; Other uses typed text).
function appendQuestion(
  turn: Turn,
  requestId: string,
  questions: QuestionDef[],
  tabId: string,
) {
  removeTyping(turn);
  const card = document.createElement("div");
  card.className = "question-card";

  // Per-question current selection state. Map question index -> Set of labels
  // (single-select keeps at most one); "Other" text lives alongside.
  const picks: Array<{ set: Set<string>; other: string }> = questions.map(() => ({
    set: new Set<string>(),
    other: "",
  }));

  questions.forEach((q, qi) => {
    const block = document.createElement("div");
    block.className = "question-block";
    const head = document.createElement("div");
    head.className = "question-head";
    if (q.header) {
      const chip = document.createElement("span");
      chip.className = "question-chip";
      chip.textContent = q.header;
      head.appendChild(chip);
    }
    const qt = document.createElement("span");
    qt.className = "question-text";
    qt.textContent = q.question;
    head.appendChild(qt);
    block.appendChild(head);

    const opts = document.createElement("div");
    opts.className = "question-options";

    const render = () => {
      opts.querySelectorAll<HTMLElement>(".question-option").forEach((el) => {
        const lbl = el.dataset.label || "";
        el.classList.toggle("selected", picks[qi].set.has(lbl));
      });
      updateSubmit();
    };

    (q.options || []).forEach((o) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "question-option";
      btn.dataset.label = o.label;
      btn.innerHTML = `<span class="opt-label"></span>${
        o.description ? `<span class="opt-desc"></span>` : ""
      }`;
      (btn.querySelector(".opt-label") as HTMLElement).textContent = o.label;
      if (o.description) {
        (btn.querySelector(".opt-desc") as HTMLElement).textContent = o.description;
      }
      btn.addEventListener("click", () => {
        const set = picks[qi].set;
        if (q.multiSelect) {
          if (set.has(o.label)) set.delete(o.label);
          else set.add(o.label);
        } else {
          set.clear();
          set.add(o.label);
        }
        render();
      });
      opts.appendChild(btn);
    });

    // "Other" free-text — selecting it reveals an input; its value becomes the
    // answer for this question (single-select replaces, multi-select appends).
    const otherBtn = document.createElement("button");
    otherBtn.type = "button";
    otherBtn.className = "question-option question-other";
    otherBtn.dataset.label = "__other__";
    otherBtn.innerHTML = `<span class="opt-label">Other…</span>`;
    const otherInput = document.createElement("input");
    otherInput.type = "text";
    otherInput.className = "question-other-input hidden";
    otherInput.placeholder = "Type your answer…";
    otherBtn.addEventListener("click", () => {
      otherInput.classList.toggle("hidden");
      if (!otherInput.classList.contains("hidden")) otherInput.focus();
      updateSubmit();
    });
    otherInput.addEventListener("input", () => {
      picks[qi].other = otherInput.value.trim();
      updateSubmit();
    });
    opts.appendChild(otherBtn);
    block.appendChild(opts);
    block.appendChild(otherInput);
    card.appendChild(block);
  });

  const actions = document.createElement("div");
  actions.className = "question-actions";
  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "question-submit";
  submit.textContent = "Submit";
  actions.appendChild(submit);
  card.appendChild(actions);

  function answeredCount(): number {
    return picks.filter((p, i) => p.set.size > 0 || (questions[i] && p.other)).length;
  }
  function updateSubmit() {
    submit.disabled = answeredCount() < questions.length;
  }
  updateSubmit();

  submit.addEventListener("click", () => {
    const answers: Record<string, string> = {};
    questions.forEach((q, qi) => {
      const labels = [...picks[qi].set];
      if (picks[qi].other) labels.push(picks[qi].other);
      answers[q.question] = labels.join(", ");
    });
    card.classList.add("answered");
    card.querySelectorAll("button, input").forEach((el) =>
      ((el as HTMLButtonElement).disabled = true),
    );
    void invoke("send_answer", { requestId, answers, tabId }).catch((e) =>
      showError(String(e)),
    );
    if (active && turn === activeTurn) ensureTyping(turn);
  });

  turn.contentEl.appendChild(card);
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
  // Reset the active workspace to a genuinely new conversation (new localId so
  // we don't overwrite the prior saved session) and start its tab fresh.
  activeWs.turns = turns;
  activeWs.activeTurn = null;
  activeWs.claudeSessionId = null;
  activeWs.localId = newLocalId();
  activeWs.title = "New session";
  localStorage.setItem(CURRENT_SESSION_KEY, activeWs.localId);
  void invoke("start_fresh_session", { tabId: activeWs.tabId }).catch(() => {});
  setResponseEmpty(true);
  updateSessionsBadge();
  persistOpenWorkspaces();
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

// True while a native window drag (win.startDragging) is in flight.
// Programmatic resizes (fitWindow → resize_height/setFrame) MUST be suppressed
// during a drag: AppKit's drag loop and our own setFrame both mutate the window
// frame, and the race makes the window jump/teleport ("glitch out") when you
// drag-and-click. We re-fit once after the drag settles.
let isDragging = false;
let dragEndTimer: number | null = null;
function endDragSoon(delay: number) {
  if (dragEndTimer !== null) window.clearTimeout(dragEndTimer);
  dragEndTimer = window.setTimeout(() => {
    isDragging = false;
    dragEndTimer = null;
    app?.classList.remove("dragging");
    requestGlassRepaint(); // re-sample the blur now that the window is still
    fitWindow(); // reconcile any size change we suppressed mid-drag
  }, delay);
}
async function beginWindowDrag() {
  if (isDragging) return; // never open two concurrent drag sessions
  isDragging = true;
  // Solidify the glass for the whole drag so a dropped backdrop-filter frame
  // can't show the desktop through the bar (see #app.dragging in style.css).
  app?.classList.add("dragging");
  endDragSoon(600); // fallback clear if it turns out to be a plain click (no move)
  try {
    await win.startDragging();
  } catch {}
}
// Each native move extends the suppression window; 150ms after the last move
// we consider the drag settled and re-enable auto-fit.
void win.onMoved(() => {
  if (isDragging) endDragSoon(150);
});

function fitWindow() {
  if (isDragging) return; // don't fight the native drag's setFrame
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
          .map((img) => `<img class="history-img" src="${escape(imgSrc(img))}" alt="" />`)
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

      await invoke("interrupt_query", { query: payload, tabId: activeWs.tabId });
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
  // Bind this query to the workspace it was launched from. All streaming below
  // routes to `ws`, not the live globals, so it keeps updating correctly even
  // if the user switches to another workspace mid-stream. `visible` is checked
  // fresh on each event because the active workspace can change at any time.
  const ws = activeWs;
  const tabId = ws.tabId;
  const isVisible = () => ws === activeWs;

  ws.active = true;
  ws.activeTurn = turn;
  if (isVisible()) {
    setActive(true);
    activeTurn = turn;
  }
  ensureTyping(turn);
  if (isVisible()) maybeFollow();
  updateSessionsBadge();

  const finishState = () => {
    ws.activeTurn = null;
    ws.active = false;
    if (isVisible()) {
      activeTurn = null;
      setActive(false);
    }
    updateSessionsBadge();
  };

  const channel = new Channel<
    | { kind: "chunk"; text: string }
    | { kind: "tool"; name: string; label: string }
    | { kind: "sessionid"; id: string }
    | { kind: "question"; request_id: string; questions: QuestionDef[] }
    | { kind: "done"; response: string }
    | { kind: "error"; message: string }
    | { kind: "cancelled" }
  >();

  channel.onmessage = (msg) => {
    // Route to this workspace's active turn (handles interrupt swap), not the
    // globally-mounted one.
    const target = ws.activeTurn ?? turn;
    if (msg.kind === "chunk") {
      setDaemonDown(false);
      appendChunk(target, msg.text);
      if (isVisible()) maybeFollow();
    } else if (msg.kind === "sessionid") {
      // Capture the claude session UUID once per workspace — pinned for
      // future --resume calls when this saved session gets restored.
      if (!ws.claudeSessionId) {
        ws.claudeSessionId = msg.id;
        if (isVisible()) currentClaudeSessionId = msg.id;
        persistOpenWorkspaces();
        saveSession(ws);
      }
    } else if (msg.kind === "tool") {
      appendTool(target, msg.name, msg.label || "");
      if (isVisible()) maybeFollow();
    } else if (msg.kind === "question") {
      appendQuestion(target, msg.request_id, msg.questions || [], ws.tabId);
      if (isVisible()) maybeFollow();
    } else if (msg.kind === "done") {
      finalizeTurn(target);
      finishState();
      saveSession(ws);
    } else if (msg.kind === "cancelled") {
      removeTyping(target);
      const note = document.createElement("div");
      note.className = "stream-note muted";
      note.textContent = "✕ cancelled";
      target.contentEl.appendChild(note);
      finalizeTurn(target);
      finishState();
    } else if (msg.kind === "error") {
      removeTyping(target);
      const err = document.createElement("p");
      err.className = "error";
      err.textContent = msg.message;
      target.contentEl.appendChild(err);
      if (/cannot reach daemon|connect|broken pipe|connection refused/i.test(msg.message)) {
        setDaemonDown(true);
      }
      finishState();
    }
  };

  try {
    await invoke("send_query", { query: payload, tabId, onEvent: channel });
  } catch (e) {
    removeTyping(turn);
    const msg = String(e);
    showError(msg);
    if (/cannot reach daemon|connect|broken pipe|connection refused/i.test(msg)) {
      setDaemonDown(true);
    }
    finishState();
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
      try { await invoke("cancel_query", { tabId: activeWs.tabId }); } catch {}
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
      if (currentModel) void repushModelAfterRestart();
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

// Cmd+drag always moves the window, from anywhere, immediately.
document.addEventListener("mousedown", (e) => {
  if (e.metaKey) {
    e.preventDefault();
    void beginWindowDrag();
  }
});

// Press-and-hold-to-drag, scoped to the INPUT BAR only (including its
// textarea). Clicking and holding in the bar, then moving past a small
// threshold, repositions the window. A press that DOESN'T move stays a normal
// click (focus the textarea, place the caret), so typing still works. The bar's
// empty space already drags natively via CSS -webkit-app-region; this handler
// adds the same behavior over the textarea (which is -webkit-app-region:no-drag
// so it stays typeable). Everything BELOW the bar — the response/chat stream,
// command palette, panels — never initiates a window drag, so text there
// selects and scrolls normally.
//
// Exempted within the bar: the actions (⋯) button and any link.
document.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || e.metaKey) return; // left only; Cmd-drag handled above
  if (isDragging) return;
  const t = e.target as HTMLElement;
  if (!t.closest(".bar")) return;            // ONLY the input bar drags
  if (t.closest("button, a")) return;        // let bar controls click through

  const startX = e.clientX;
  const startY = e.clientY;
  let started = false;
  const onMove = (ev: MouseEvent) => {
    if (started) return;
    // Only a deliberate hold-and-move (past 5px) becomes a drag; a smaller
    // movement stays a click so caret placement in the textarea still works.
    if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 5) {
      started = true;
      cleanup();
      void beginWindowDrag();
    }
  };
  const cleanup = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", cleanup);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", cleanup);
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
// Restore persisted workspaces (or start a single fresh default). Deferred to a
// microtask so all module-level consts (CURRENT_SESSION_KEY etc.) are defined.
queueMicrotask(() => void initWorkspaces());

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

// Per-workspace debounce so a background workspace finishing a turn doesn't
// cancel the active workspace's pending save (and vice versa).
const saveTimers = new Map<string, number>();
function saveSession(ws: Workspace = activeWs) {
  // Make sure the active workspace's record reflects the live globals before
  // we snapshot it.
  if (ws === activeWs) {
    ws.turns = turns;
    ws.claudeSessionId = currentClaudeSessionId;
  }
  const prev = saveTimers.get(ws.localId);
  if (prev !== undefined) window.clearTimeout(prev);
  const timer = window.setTimeout(async () => {
    saveTimers.delete(ws.localId);
    if (ws.turns.length === 0) return;
    // Use the most recent meaningful query as preview — easier to identify a
    // session by where it ended up than where it started.
    const recent = [...ws.turns]
      .reverse()
      .find((t) => !t.side && t.query.trim().length > 0);
    const preview = ((recent ?? ws.turns[0])?.query || "").slice(0, 80);
    ws.title = preview || ws.title;
    const snapshot: SavedSession = {
      id: ws.localId,
      savedAt: Date.now(),
      preview,
      claudeSessionId: ws.claudeSessionId ?? undefined,
      turns: ws.turns.map((t) => ({
        id: t.id,
        query: t.query,
        fullText: t.fullText,
        pastes: t.pastedTexts,
        // Persist only a lightweight image REFERENCE (path), not the base64
        // dataUrl — that bloated sessions.json to ~16MB (and choked the iOS
        // fetch). The bytes still live on disk in spotlight-images/ at `path`.
        images: (t.images ?? []).map((im) => ({ path: im.path, dataUrl: "" })),
        files: t.files,
      })),
    };
    const all = (await loadSessions()).filter((s) => s.id !== ws.localId);
    all.unshift(snapshot);
    await writeSessions(all);
  }, 800);
  saveTimers.set(ws.localId, timer);
}

/** Rebuild saved turns into the currently-mounted workspace's DOM + globals. */
// Render a saved turn's fullText, turning embedded mid-stream injection markers
// into proper user bubbles. The marker line ("[user injected mid-stream]: X")
// is produced by send(); here we reverse it for display.
const INJECTION_MARKER = /\n*\[user injected mid-stream\]:\s*([\s\S]*?)\n+/g;
function renderFullTextWithInjections(turn: Turn, fullText: string) {
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  const addText = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const el = document.createElement("div");
    el.className = "text-seg";
    (el as any)._content = trimmed;
    el.innerHTML = md.render(trimmed);
    turn.contentEl.appendChild(el);
    turn.segments.push(el);
    enhanceCodeBlocks(el);
  };
  INJECTION_MARKER.lastIndex = 0;
  while ((m = INJECTION_MARKER.exec(fullText)) !== null) {
    addText(fullText.slice(lastIndex, m.index));
    const inj = document.createElement("div");
    inj.className = "inline-injection";
    inj.textContent = (m[1] || "").trim();
    turn.contentEl.appendChild(inj);
    lastIndex = INJECTION_MARKER.lastIndex;
  }
  addText(fullText.slice(lastIndex));
}

function rebuildTurnsFromSaved(s: SavedSession) {
  for (const t of s.turns) {
    const turn = createTurn({
      query: t.query,
      pastes: t.pastes || [],
      images: t.images || [],
      files: t.files || [],
    });
    turns.push(turn);
    if (t.fullText) {
      // fullText interleaves assistant prose with mid-stream user injections,
      // tagged by the internal "[user injected mid-stream]: …" marker. Split on
      // the marker so injections render as user bubbles (not literal marker
      // text) and the surrounding assistant text renders as markdown.
      renderFullTextWithInjections(turn, t.fullText);
      turn.fullText = t.fullText;
    }
    finalizeTurn(turn);
  }
  setResponseEmpty(turns.length === 0);
  maybeFollow();
}

/** Arm the daemon to reattach (or fall back to a text preamble) for a tab. */
function armResume(s: SavedSession, tabId: string) {
  if (s.claudeSessionId) {
    void invoke("resume_session", { uuid: s.claudeSessionId, tabId }).catch((e) => {
      console.error("[spotlight] resume_session failed:", e);
    });
  } else {
    const transcript = s.turns
      .map((t) => `## you\n${t.query}\n\n## assistant\n${t.fullText}`)
      .join("\n\n---\n\n");
    pendingResumeContext =
      `[Restored session — context below was a prior conversation. ` +
      `Treat it as already-said context, not a new instruction.]\n\n` +
      transcript +
      `\n\n[end restored context]`;
    void invoke("start_fresh_session", { tabId }).catch(() => {});
  }
}

/** Restore a saved session into the ACTIVE workspace (replaces its content). */
function restoreSession(s: SavedSession) {
  clearAll();
  cancelHeightAnim();
  activeWs.localId = s.id;
  activeWs.title = s.preview || "Session";
  activeWs.claudeSessionId = s.claudeSessionId ?? null;
  currentClaudeSessionId = s.claudeSessionId ?? null;
  localStorage.setItem(CURRENT_SESSION_KEY, s.id);
  armResume(s, activeWs.tabId);
  rebuildTurnsFromSaved(s);
  persistOpenWorkspaces();
}

/** Open a saved session as its own workspace (switch to it if already open). */
async function openSavedSession(s: SavedSession) {
  const existing = workspaces.find((w) => w.localId === s.id);
  if (existing) {
    switchWorkspace(existing);
    return;
  }
  let tabId: string;
  try {
    tabId = await invoke<string>("new_tab");
  } catch {
    tabId = `tab-local-${Date.now()}`;
  }
  const ws = makeWorkspace({
    tabId,
    localId: s.id,
    title: s.preview || "Session",
    claudeSessionId: s.claudeSessionId ?? null,
  });
  workspaces.push(ws);
  switchWorkspace(ws); // mounts an empty responseInner for ws
  rebuildTurnsFromSaved(s); // fills it
  syncActiveWorkspace();
  armResume(s, tabId);
  persistOpenWorkspaces();
}

async function openSessionsPanel() {
  const all = await loadSessions(true);
  // Saved sessions that aren't already open as a workspace become the
  // "reopen" list; open workspaces are shown at the top as live switchers.
  const openIds = new Set(workspaces.map((w) => w.localId));
  const saved = all.filter((s) => !openIds.has(s.id));

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
        <button class="ws-new" title="New session">+ New</button>
        <button class="paste-overlay-close">×</button>
      </div>
      <div class="session-list"></div>
    </div>`;
  const list = overlay.querySelector(".session-list") as HTMLDivElement;

  const openRows = workspaces
    .map((w) => {
      const streaming = w === activeWs ? active : w.active;
      const isActive = w === activeWs;
      const label = (w === activeWs ? currentClaudeSessionId : w.claudeSessionId)
        ? w.title
        : w.title || "New session";
      return (
        `<div class="session-row ws-row${isActive ? " ws-active" : ""}" data-ws="${escape(w.localId)}">` +
        `<div class="ws-dot${streaming ? " streaming" : ""}"></div>` +
        `<div class="session-preview">${escape(label || "(empty)")}</div>` +
        `${workspaces.length > 1 ? `<button class="ws-close" data-close="${escape(w.localId)}" title="Close session">×</button>` : ""}` +
        `</div>`
      );
    })
    .join("");

  const savedRows = saved
    .map(
      (s) =>
        `<div class="session-row" data-id="${escape(s.id)}">` +
        `<div class="session-preview">${escape(s.preview || "(empty)")}</div>` +
        `<div class="session-meta">${new Date(s.savedAt).toLocaleString()} · ${s.turns.length} turn${s.turns.length === 1 ? "" : "s"}</div>` +
        `</div>`,
    )
    .join("");

  list.innerHTML =
    `<div class="session-group-label">OPEN</div>${openRows}` +
    (savedRows
      ? `<div class="session-group-label">SAVED</div>${savedRows}`
      : "");

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
  overlay.querySelector(".ws-new")!.addEventListener("click", () => {
    close();
    void openWorkspace();
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  list.addEventListener("click", (e) => {
    const el = e.target as HTMLElement;
    // Close button on an open workspace row.
    const closeId = el.closest(".ws-close")?.getAttribute("data-close");
    if (closeId) {
      e.stopPropagation();
      const w = workspaces.find((x) => x.localId === closeId);
      if (w) void closeWorkspace(w);
      close();
      return;
    }
    const row = el.closest(".session-row") as HTMLElement | null;
    if (!row) return;
    if (row.dataset.ws) {
      const w = workspaces.find((x) => x.localId === row.dataset.ws);
      if (w) switchWorkspace(w);
      close();
      return;
    }
    if (row.dataset.id) {
      const sess = all.find((s) => s.id === row.dataset.id);
      if (sess) void openSavedSession(sess);
      close();
    }
  });
}
// Back-compat alias for the /sessions slash command.
const openSessionPicker = openSessionsPanel;

// ============================================================
// /model — pick the model the daemon passes to claude (--model)
// ============================================================

function openModelPicker() {
  cancelHeightAnim();
  const wantedH = 320;
  suppressResizeWatcher = true;
  cachedH = wantedH;
  void invoke("resize_height", { height: wantedH }).catch(() => {});
  setTimeout(() => { suppressResizeWatcher = false; }, 30);

  const overlay = document.createElement("div");
  overlay.className = "paste-overlay";
  const rows = MODELS.map(
    (m) =>
      `<div class="session-row model-row${m.id === currentModel ? " ws-active" : ""}" data-model="${escape(m.id)}">` +
      `<div class="model-check">${m.id === currentModel ? "✓" : ""}</div>` +
      `<div class="model-text"><div class="session-preview">${escape(m.label)}</div>` +
      `<div class="session-meta">${escape(m.note)}</div></div>` +
      `</div>`,
  ).join("");
  overlay.innerHTML = `
    <div class="paste-overlay-card session-picker">
      <div class="paste-overlay-head">
        <span class="paste-tag">MODEL</span>
        <button class="paste-overlay-close">×</button>
      </div>
      <div class="session-list">${rows}</div>
    </div>`;

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
  overlay.querySelector(".session-list")!.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest(".model-row") as HTMLElement | null;
    if (!row) return;
    const id = row.dataset.model ?? "";
    currentModel = id;
    void persistModel(id);
    void invoke("set_model", { model: id }).catch((err) =>
      showToast("Model set failed: " + err),
    );
    showToast(`Model → ${modelLabel(id)}`);
    close();
  });
}

// ============================================================
// /usage — cost + token counters from the daemon
// ============================================================

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

async function openUsagePanel() {
  let stats: any;
  try {
    const raw = await invoke<string>("get_usage");
    stats = JSON.parse(raw);
  } catch (e) {
    showToast("Usage unavailable: " + e);
    return;
  }

  cancelHeightAnim();
  const wantedH = 420;
  suppressResizeWatcher = true;
  cachedH = wantedH;
  void invoke("resize_height", { height: wantedH }).catch(() => {});
  setTimeout(() => { suppressResizeWatcher = false; }, 30);

  const cost = typeof stats.costUsd === "number" ? stats.costUsd : 0;
  const since = stats.since ? new Date(stats.since).toLocaleString() : "—";
  const byModel = stats.byModel && typeof stats.byModel === "object" ? stats.byModel : {};
  const modelRows = Object.entries(byModel)
    .map(([model, b]: [string, any]) => {
      const inTok = (b.inputTokens || 0) + (b.cacheReadTokens || 0) + (b.cacheCreateTokens || 0);
      return (
        `<div class="usage-model-row">` +
        `<div class="usage-model-name">${escape(model)}</div>` +
        `<div class="usage-model-stat">${b.turns || 0} turns</div>` +
        `<div class="usage-model-stat">${fmtTokens(inTok)} in · ${fmtTokens(b.outputTokens || 0)} out</div>` +
        `<div class="usage-model-stat">$${(b.costUsd || 0).toFixed(2)}</div>` +
        `</div>`
      );
    })
    .join("");

  const overlay = document.createElement("div");
  overlay.className = "paste-overlay";
  overlay.innerHTML = `
    <div class="paste-overlay-card session-picker usage-card">
      <div class="paste-overlay-head">
        <span class="paste-tag">USAGE</span>
        <button class="usage-reset" title="Reset counters">Reset</button>
        <button class="paste-overlay-close">×</button>
      </div>
      <div class="usage-body">
        <div class="usage-hero">
          <div class="usage-cost">$${cost.toFixed(2)}</div>
          <div class="usage-cost-label">${stats.turns || 0} turn${stats.turns === 1 ? "" : "s"} · model: ${escape(modelLabel(stats.model || ""))}</div>
        </div>
        <div class="usage-grid">
          <div class="usage-cell"><span class="usage-num">${fmtTokens(stats.inputTokens || 0)}</span><span class="usage-cap">Input</span></div>
          <div class="usage-cell"><span class="usage-num">${fmtTokens(stats.outputTokens || 0)}</span><span class="usage-cap">Output</span></div>
          <div class="usage-cell"><span class="usage-num">${fmtTokens(stats.cacheReadTokens || 0)}</span><span class="usage-cap">Cache read</span></div>
          <div class="usage-cell"><span class="usage-num">${fmtTokens(stats.cacheCreateTokens || 0)}</span><span class="usage-cap">Cache write</span></div>
        </div>
        ${modelRows ? `<div class="session-group-label">BY MODEL</div>${modelRows}` : ""}
        <div class="usage-since">since ${escape(since)}</div>
      </div>
    </div>`;

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
  overlay.querySelector(".usage-reset")!.addEventListener("click", async () => {
    try {
      await invoke("reset_usage");
      showToast("Usage reset");
    } catch (e) {
      showToast("Reset failed: " + e);
    }
    close();
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
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
