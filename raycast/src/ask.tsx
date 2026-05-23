import { List, ActionPanel, Action, Icon, getPreferenceValues, LaunchProps } from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import net from "net";

interface Preferences { socketPath: string }
interface Args { query: string }
type Message = { role: "user" | "assistant"; text: string };

export default function Ask(props: LaunchProps<{ arguments: Args }>) {
  const { socketPath } = getPreferenceValues<Preferences>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [searchText, setSearchText] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSearchText("");
    setError(null);
    setIsLoading(true);
    setMessages((prev) => [...prev, { role: "user", text: trimmed }, { role: "assistant", text: "" }]);
    streamFromDaemon(socketPath, trimmed, {
      onChunk: (c) =>
        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = { role: "assistant", text: next[next.length - 1].text + c };
          return next;
        }),
      onDone: (full) => {
        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = { role: "assistant", text: full };
          return next;
        });
        setIsLoading(false);
      },
      onError: (e) => { setError(e); setIsLoading(false); },
    });
  };

  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (props.arguments.query?.trim()) send(props.arguments.query);
  }, []);

  const transcript = renderTranscript(messages, error);
  const fullCopy = messages.map((m) => `${m.role === "user" ? "You" : "Claude"}: ${m.text}`).join("\n\n");
  const draft = searchText.trim();
  const detail = <List.Item.Detail markdown={transcript || "_…_"} />;

  return (
    <List
      isLoading={isLoading}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="Message…"
      isShowingDetail
      navigationTitle=""
      filtering={false}
    >
      <List.Item
        title=""
        icon={draft ? Icon.ArrowUp : isLoading ? Icon.CircleProgress : Icon.Person}
        actions={
          <ActionPanel>
            {draft && (
              <Action title="Send" icon={Icon.ArrowUp} onAction={() => send(searchText)} />
            )}
            <Action.CopyToClipboard
              title="Copy Transcript"
              content={fullCopy}
              shortcut={{ modifiers: ["cmd"], key: "c" }}
              icon={Icon.Clipboard}
            />
          </ActionPanel>
        }
        detail={detail}
      />
    </List>
  );
}

function renderTranscript(messages: Message[], error: string | null): string {
  if (messages.length === 0) return "";
  const blocks = messages.map((m) =>
    m.role === "user" ? `**${m.text}**` : (m.text || "…")
  );
  let out = blocks.join("\n\n");
  if (error) out += `\n\n_${error}_`;
  return out;
}

function streamFromDaemon(
  socketPath: string,
  query: string,
  cb: { onChunk: (s: string) => void; onDone: (full: string) => void; onError: (msg: string) => void }
) {
  const socket = net.createConnection(socketPath);
  let buf = "";
  let collected = "";

  socket.on("connect", () => socket.write(JSON.stringify({ query }) + "\n"));
  socket.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx: number;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.error) { cb.onError(msg.error); socket.destroy(); return; }
        if (msg.chunk) { collected += msg.chunk; cb.onChunk(msg.chunk); }
        if (msg.done) {
          cb.onDone(typeof msg.response === "string" ? msg.response : collected.trim());
          socket.destroy();
        }
      } catch { /* ignore */ }
    }
  });
  socket.on("error", (e) => cb.onError(e.message));
}
