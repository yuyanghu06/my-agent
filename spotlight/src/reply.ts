import { invoke, Channel } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import MarkdownIt from "markdown-it";
// @ts-ignore — no published types
import mdKatex from "@vscode/markdown-it-katex";
import "katex/dist/katex.min.css";
// @ts-ignore — types ship in dist but editor resolution can lag
import { setLiquidGlassEffect } from "tauri-plugin-liquid-glass-api";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
md.use((mdKatex as any).default ?? mdKatex, { throwOnError: false, strict: false });
const win = getCurrentWindow();

// Native Liquid Glass behind this transparent reply window (matches #reply-app's
// 8px radius). See main.ts for the full rationale. Safe no-op off macOS 26.
setLiquidGlassEffect({ cornerRadius: 8 }).catch((e: unknown) =>
  console.warn("[spotlight] liquid glass unavailable:", e),
);

const params = new URLSearchParams(
  location.search ? location.search.slice(1) : location.hash.slice(1),
);
const mode = (params.get("mode") || "inject") as "inject" | "side";
const quote = params.get("quote") || "";

const tagEl = document.getElementById("reply-mode-tag") as HTMLSpanElement;
const quoteEl = document.getElementById("reply-quote") as HTMLSpanElement;
const bodyEl = document.getElementById("reply-body") as HTMLDivElement;
const composer = document.getElementById("reply-composer") as HTMLTextAreaElement;
const closeBtn = document.getElementById("reply-close") as HTMLButtonElement;

tagEl.textContent = mode === "side" ? "SIDE" : "REPLY";
// Render the quoted snippet through markdown-it so inline LaTeX ($…$, \(…\))
// and basic markdown match how it appears in the main turn.
const quoteTrunc = quote.length > 90 ? quote.slice(0, 90) + "…" : quote;
quoteEl.innerHTML = md.renderInline(quoteTrunc);

closeBtn.addEventListener("click", () => win.close());

// Side/reply windows persist when the user tabs to other apps — they only
// close on Esc, the × button, or after the user explicitly dismisses.

let active = false;

composer.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    win.close();
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void send(composer.value);
  }
});

async function send(text: string) {
  const trimmed = text.trim();
  if (!trimmed || active) return;
  active = true;
  composer.disabled = true;
  composer.value = "";

  const userEl = document.createElement("div");
  userEl.className = "reply-user";
  userEl.textContent = trimmed;
  bodyEl.appendChild(userEl);

  const respEl = document.createElement("div");
  respEl.className = "reply-resp";
  respEl.innerHTML = `<span class="typing"><span></span><span></span><span></span></span>`;
  bodyEl.appendChild(respEl);
  bodyEl.scrollTop = bodyEl.scrollHeight;

  const payload = quote
    ? `[Re: assistant said "${quote.slice(0, 200)}"]\n\n${trimmed}`
    : trimmed;

  const channel = new Channel<
    | { kind: "chunk"; text: string }
    | { kind: "tool"; name: string; label: string }
    | { kind: "done"; response: string }
    | { kind: "error"; message: string }
    | { kind: "cancelled" }
  >();
  let collected = "";
  channel.onmessage = (msg) => {
    if (msg.kind === "chunk") {
      collected += msg.text;
      respEl.innerHTML = md.render(collected);
      bodyEl.scrollTop = bodyEl.scrollHeight;
    } else if (msg.kind === "done" || msg.kind === "cancelled") {
      if (collected) respEl.innerHTML = md.render(collected);
      composer.disabled = false;
      composer.focus();
      active = false;
    } else if (msg.kind === "error") {
      respEl.innerHTML = `<span class="error">${msg.message}</span>`;
      composer.disabled = false;
      composer.focus();
      active = false;
    }
  };

  try {
    await invoke("send_query", { query: payload, onEvent: channel });
  } catch (e) {
    respEl.innerHTML = `<span class="error">${String(e)}</span>`;
    composer.disabled = false;
    composer.focus();
    active = false;
  }
}

// Open external links in default browser
document.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest("a") as HTMLAnchorElement | null;
  if (!a) return;
  const href = a.getAttribute("href") || "";
  if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;
  e.preventDefault();
  invoke("open_external", { url: href }).catch(() => {});
});

composer.focus();
