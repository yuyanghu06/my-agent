#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose, Engine as _};
use serde::Serialize;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::process::{Child, Command};
use std::sync::{Mutex, OnceLock};
use tauri::{ipc::Channel, AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

const SOCKET_PATH: &str = "/tmp/claude-agent.sock";
const LAUNCHD_LABEL: &str = "com.yuyang.agent";
const AGENT_ROOT: &str = "/Users/yuyang/Documents/my-agent";
const SESSIONS_FILE: &str = "/Users/yuyang/Documents/my-agent/spotlight-sessions/sessions.json";
const IMAGES_DIR: &str = "/Users/yuyang/Documents/my-agent/spotlight-images";
const FILES_DIR: &str = "/Users/yuyang/Documents/my-agent/spotlight-files";
const CLIPS_DIR: &str = "/Users/yuyang/Documents/my-agent/spotlight-clips";
const SETTINGS_FILE: &str = "/Users/yuyang/Documents/my-agent/spotlight-sessions/settings.json";

/// Active `screencapture -v` child while a screen recording is in flight.
/// Holds (child, output_path). Cleared once stop_screen_capture finalizes.
static CAPTURE_CHILD: OnceLock<Mutex<Option<(Child, String)>>> = OnceLock::new();
fn capture_child() -> &'static Mutex<Option<(Child, String)>> {
    CAPTURE_CHILD.get_or_init(|| Mutex::new(None))
}

/// Write half of the socket connection that owns the current in-flight query.
/// cancel_query / interrupt_query write control messages here so the daemon
/// receives them on the same connection it associates with the live query.
static ACTIVE_WRITER: OnceLock<Mutex<Option<UnixStream>>> = OnceLock::new();
fn active_writer() -> &'static Mutex<Option<UnixStream>> {
    ACTIVE_WRITER.get_or_init(|| Mutex::new(None))
}
fn set_active_writer(s: Option<UnixStream>) {
    if let Ok(mut g) = active_writer().lock() {
        *g = s;
    }
}
fn write_control(json: &serde_json::Value) -> Result<(), String> {
    let guard = active_writer().lock().map_err(|e| e.to_string())?;
    let s = guard.as_ref().ok_or("no active query")?;
    let mut s = s.try_clone().map_err(|e| e.to_string())?;
    writeln!(s, "{}", json).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum StreamEvent {
    Chunk { text: String },
    Tool { name: String, label: String },
    SessionId { id: String },
    Done { response: String },
    Error { message: String },
    Cancelled,
}

#[tauri::command]
async fn send_query(query: String, on_event: Channel<StreamEvent>) -> Result<(), String> {
    std::thread::spawn(move || {
        let stream = match UnixStream::connect(SOCKET_PATH) {
            Ok(s) => s,
            Err(e) => {
                let _ = on_event.send(StreamEvent::Error {
                    message: format!("Cannot reach daemon at {}: {}", SOCKET_PATH, e),
                });
                return;
            }
        };

        // Park a clone for cancel/interrupt to write to.
        if let Ok(w) = stream.try_clone() {
            set_active_writer(Some(w));
        }

        let mut writer = stream.try_clone().expect("clone socket");
        let req = serde_json::json!({ "query": query });
        if let Err(e) = writeln!(writer, "{}", req) {
            let _ = on_event.send(StreamEvent::Error { message: format!("write failed: {}", e) });
            set_active_writer(None);
            return;
        }
        // keep `writer` alive — interrupt may need to write on the same fd

        let reader = BufReader::new(stream);
        let mut collected = String::new();

        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(e) => {
                    let _ = on_event.send(StreamEvent::Error { message: format!("read failed: {}", e) });
                    set_active_writer(None);
                    return;
                }
            };
            if line.trim().is_empty() {
                continue;
            }
            let v: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            if v.get("cancelled").and_then(|c| c.as_bool()).unwrap_or(false) {
                let _ = on_event.send(StreamEvent::Cancelled);
                set_active_writer(None);
                return;
            }
            if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
                let _ = on_event.send(StreamEvent::Error { message: err.to_string() });
                set_active_writer(None);
                return;
            }
            if let Some(sid) = v.get("session_id").and_then(|s| s.as_str()) {
                let _ = on_event.send(StreamEvent::SessionId { id: sid.to_string() });
            }
            if let Some(tool) = v.get("tool").and_then(|t| t.as_str()) {
                let label = v
                    .get("label")
                    .and_then(|l| l.as_str())
                    .unwrap_or("")
                    .to_string();
                let _ = on_event.send(StreamEvent::Tool {
                    name: tool.to_string(),
                    label,
                });
            }
            if let Some(chunk) = v.get("chunk").and_then(|c| c.as_str()) {
                if !chunk.is_empty() {
                    collected.push_str(chunk);
                    let _ = on_event.send(StreamEvent::Chunk { text: chunk.to_string() });
                }
            }
            if v.get("done").and_then(|d| d.as_bool()).unwrap_or(false) {
                let response = v
                    .get("response")
                    .and_then(|r| r.as_str())
                    .unwrap_or(collected.as_str())
                    .to_string();
                let _ = on_event.send(StreamEvent::Done { response });
                set_active_writer(None);
                return;
            }
        }

        let _ = on_event.send(StreamEvent::Done { response: collected });
        set_active_writer(None);
    });

    Ok(())
}

#[tauri::command]
async fn cancel_query() -> Result<(), String> {
    write_control(&serde_json::json!({ "cancel": true }))
}

/// Tell the daemon to use --resume <uuid> on the next query so claude
/// reattaches to a specific prior session. Used by spotlight when restoring
/// a saved session that has a captured claudeSessionId.
#[tauri::command]
async fn resume_session(uuid: String) -> Result<(), String> {
    let mut s = UnixStream::connect(SOCKET_PATH).map_err(|e| e.to_string())?;
    writeln!(s, "{}", serde_json::json!({ "resume": uuid })).map_err(|e| e.to_string())?;
    Ok(())
}

/// Tell the daemon to drop --continue on the next query so claude starts a
/// brand-new session. Used on /clear and on app launch.
#[tauri::command]
async fn start_fresh_session() -> Result<(), String> {
    // One-shot socket connection — the daemon stores the flag globally, so
    // we don't need to reuse the active query's connection.
    let mut s = UnixStream::connect(SOCKET_PATH).map_err(|e| e.to_string())?;
    writeln!(s, "{}", serde_json::json!({ "fresh": true })).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn interrupt_query(query: String) -> Result<(), String> {
    write_control(&serde_json::json!({ "query": query, "interrupt": true }))
}

/// Resize the window with NO animation, bypassing AppKit's implicit
/// setFrame animation. Tauri's set_size call goes through setContentSize:
/// which CAN animate depending on AppKit version + private-api configuration;
/// using setFrame:display:animate:NO directly is the only way to guarantee
/// an instant resize. Width is preserved; height is in logical points.
/// Resize the window to a given logical height with NO animation. Bypasses
/// Tauri's set_size (which can animate via AppKit on some configs) by calling
/// setFrame:display:animate:NO directly.
#[tauri::command]
async fn resize_height(window: tauri::Window, height: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let win_for_thread = window.clone();
        window
            .run_on_main_thread(move || unsafe {
                use cocoa::base::{id, NO};
                use cocoa::foundation::{NSPoint, NSRect, NSSize};
                use objc::{msg_send, sel, sel_impl};

                let ns_window = match win_for_thread.ns_window() {
                    Ok(p) => p as id,
                    Err(_) => return,
                };
                let frame: NSRect = msg_send![ns_window, frame];
                let new_h = height;
                // Anchor the top edge — grow downward.
                let old_top = frame.origin.y + frame.size.height;
                let new_origin_y = old_top - new_h;
                let new_frame = NSRect::new(
                    NSPoint::new(frame.origin.x, new_origin_y),
                    NSSize::new(frame.size.width, new_h),
                );
                let _: () = msg_send![ns_window, setFrame: new_frame display: NO animate: NO];
            })
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, height);
    }
    Ok(())
}

/// Open a small floating window containing the inline-reply composer. The
/// window is independent — it does NOT resize the main spotlight window.
#[tauri::command]
async fn open_reply_window(
    app: tauri::AppHandle,
    turn_id: String,
    mode: String,
    quote: String,
    screen_x: f64,
    screen_y: f64,
) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    let label = format!(
        "reply-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let qs = format!(
        "mode={}&turn={}&quote={}",
        urlencoding(&mode),
        urlencoding(&turn_id),
        urlencoding(&quote)
    );
    // Use a query string instead of a hash fragment — PathBuf's serialization
    // of `#` can get URL-encoded by Tauri's URL builder, breaking the params.
    let url = format!("reply.html?{}", qs);
    eprintln!("[spotlight] open_reply_window url={} pos=({}, {})", url, screen_x, screen_y);
    let w = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title("Reply")
        .inner_size(420.0, 280.0)
        .min_inner_size(360.0, 180.0)
        .max_inner_size(720.0, 600.0)
        .always_on_top(false)
        .decorations(false)
        .transparent(true)
        .resizable(true)
        .skip_taskbar(true)
        .build()
        .map_err(|e| e.to_string())?;
    // Clamp into the screen the desired position falls inside, so the window
    // never opens off-screen on multi-monitor setups (where webview's
    // window.screen.availLeft/Top return unreliable values).
    let (cx, cy) = clamp_to_screen_macos(&w, screen_x, screen_y, 420.0, 280.0);
    use tauri::{LogicalPosition, Position};
    w.set_position(Position::Logical(LogicalPosition::new(cx, cy)))
        .map_err(|e| e.to_string())?;
    eprintln!("[spotlight] reply window placed at ({}, {})", cx, cy);

    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
        let _ = apply_vibrancy(
            &w,
            NSVisualEffectMaterial::Sheet,
            Some(NSVisualEffectState::Active),
            Some(14.0),
        );

        if let Ok(ns_window) = w.ns_window() {
            use cocoa::base::{id, nil};
            use cocoa::foundation::NSString;
            use objc::{class, msg_send, sel, sel_impl};
            let ns_window = ns_window as id;
            unsafe {
                let name = NSString::alloc(nil).init_str("NSAppearanceNameAqua");
                let appearance: id = msg_send![class!(NSAppearance), appearanceNamed: name];
                let _: () = msg_send![ns_window, setAppearance: appearance];
            }
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn clamp_to_screen_macos(
    win: &tauri::WebviewWindow,
    desired_x: f64,
    desired_y: f64,
    win_w: f64,
    win_h: f64,
) -> (f64, f64) {
    use cocoa::appkit::NSScreen;
    use cocoa::base::{id, nil};
    use cocoa::foundation::NSArray;
    use objc::{msg_send, sel, sel_impl};

    let margin = 12.0;
    unsafe {
        let screens: id = NSScreen::screens(nil);
        if screens == nil {
            return (desired_x, desired_y);
        }
        let count: usize = msg_send![screens, count];
        // Find the screen whose visibleFrame contains the point.
        let mut best: Option<(f64, f64, f64, f64)> = None;
        for i in 0..count {
            let s: id = msg_send![screens, objectAtIndex: i];
            let frame: cocoa::foundation::NSRect = msg_send![s, visibleFrame];
            // AppKit uses bottom-left origin in *backing* coords; Tauri's
            // LogicalPosition uses top-left in points. Convert frame to
            // top-left by inverting Y against the primary screen height.
            let primary: id = msg_send![screens, objectAtIndex: 0_usize];
            let pframe: cocoa::foundation::NSRect = msg_send![primary, frame];
            let primary_h = pframe.size.height;
            let x = frame.origin.x;
            let y_from_top = primary_h - (frame.origin.y + frame.size.height);
            let w = frame.size.width;
            let h = frame.size.height;
            if desired_x >= x
                && desired_x <= x + w
                && desired_y >= y_from_top
                && desired_y <= y_from_top + h
            {
                best = Some((x, y_from_top, w, h));
                break;
            }
            // Track the closest containing screen as a fallback.
            if best.is_none() {
                best = Some((x, y_from_top, w, h));
            }
        }
        let (sx, sy, sw, sh) = best.unwrap_or((0.0, 0.0, 1440.0, 900.0));
        let cx = desired_x.max(sx + margin).min(sx + sw - win_w - margin);
        let cy = desired_y.max(sy + margin).min(sy + sh - win_h - margin);
        let _ = win;
        (cx, cy)
    }
}

#[cfg(not(target_os = "macos"))]
fn clamp_to_screen_macos(
    _win: &tauri::WebviewWindow,
    x: f64,
    y: f64,
    _w: f64,
    _h: f64,
) -> (f64, f64) {
    (x, y)
}

/// Tiny percent-encoder for the hash params we ship to reply.html. Avoids
/// pulling in the `urlencoding` crate just for three fields.
fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char);
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

#[tauri::command]
async fn open_external(url: String) -> Result<(), String> {
    // macOS only — `open` routes to the user's default browser.
    Command::new("/usr/bin/open")
        .arg(&url)
        .spawn()
        .map_err(|e| format!("open failed: {}", e))?;
    Ok(())
}

#[tauri::command]
async fn save_image(data_url: String) -> Result<String, String> {
    let comma = data_url.find(',').ok_or("invalid data URL")?;
    let header = &data_url[..comma];
    let b64 = &data_url[comma + 1..];
    let bytes = general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("decode failed: {}", e))?;

    let ext = if header.contains("png") {
        "png"
    } else if header.contains("jpeg") || header.contains("jpg") {
        "jpg"
    } else if header.contains("webp") {
        "webp"
    } else if header.contains("gif") {
        "gif"
    } else {
        "png"
    };

    let dir = std::path::PathBuf::from(IMAGES_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir failed: {}", e))?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let path = dir.join(format!("{}.{}", ts, ext));
    std::fs::write(&path, &bytes).map_err(|e| format!("write failed: {}", e))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Save an arbitrary file (any type) under spotlight-files/. Mirrors save_image
/// but preserves the original filename so the model sees a meaningful path.
/// Filenames are prefixed with a timestamp to avoid collisions.
#[tauri::command]
async fn save_file(name: String, data_url: String) -> Result<String, String> {
    let comma = data_url.find(',').ok_or("invalid data URL")?;
    let b64 = &data_url[comma + 1..];
    let bytes = general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("decode failed: {}", e))?;

    let dir = std::path::PathBuf::from(FILES_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir failed: {}", e))?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let safe: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' })
        .collect();
    let safe = if safe.is_empty() { "file".to_string() } else { safe };
    let path = dir.join(format!("{}_{}", ts, safe));
    std::fs::write(&path, &bytes).map_err(|e| format!("write failed: {}", e))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn read_sessions() -> Result<String, String> {
    let path = std::path::PathBuf::from(SESSIONS_FILE);
    if !path.exists() {
        return Ok("[]".to_string());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("read failed: {}", e))
}

#[tauri::command]
async fn write_sessions(json: String) -> Result<(), String> {
    let path = std::path::PathBuf::from(SESSIONS_FILE);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {}", e))?;
    }
    std::fs::write(&path, json).map_err(|e| format!("write failed: {}", e))?;
    Ok(())
}

#[tauri::command]
async fn read_settings() -> Result<String, String> {
    let path = std::path::PathBuf::from(SETTINGS_FILE);
    if !path.exists() {
        return Ok("{}".to_string());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("read failed: {}", e))
}

#[tauri::command]
async fn write_settings(json: String) -> Result<(), String> {
    let path = std::path::PathBuf::from(SETTINGS_FILE);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {}", e))?;
    }
    std::fs::write(&path, json).map_err(|e| format!("write failed: {}", e))
}

#[derive(Serialize)]
struct ClipInfo {
    path: String,
    name: String,
    size: u64,
}

#[tauri::command]
async fn start_screen_capture() -> Result<String, String> {
    let dir = std::path::PathBuf::from(CLIPS_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir failed: {}", e))?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let path = dir.join(format!("clip_{}.mov", ts));
    let path_str = path.to_string_lossy().into_owned();
    {
        let guard = capture_child().lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            return Err("already recording".into());
        }
    }
    // -v records video until interrupted; -C includes the cursor; -x silences
    // the shutter sound (still required for video on some builds).
    let child = Command::new("/usr/sbin/screencapture")
        .args(["-v", "-C", "-x", &path_str])
        .spawn()
        .map_err(|e| format!("spawn failed: {}", e))?;
    let mut guard = capture_child().lock().map_err(|e| e.to_string())?;
    *guard = Some((child, path_str.clone()));
    Ok(path_str)
}

#[tauri::command]
async fn stop_screen_capture() -> Result<ClipInfo, String> {
    let (mut child, path) = {
        let mut guard = capture_child().lock().map_err(|e| e.to_string())?;
        guard.take().ok_or("not recording")?
    };
    // SIGINT to screencapture finalizes the .mov cleanly. SIGTERM truncates.
    let pid = child.id().to_string();
    let _ = Command::new("/bin/kill").args(["-INT", &pid]).status();
    let _ = child.wait();
    // screencapture sometimes flushes the moov atom a beat after exit.
    for _ in 0..40 {
        if let Ok(md) = std::fs::metadata(&path) {
            if md.len() > 0 {
                let name = std::path::Path::new(&path)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "clip.mov".to_string());
                return Ok(ClipInfo { path: path.clone(), name, size: md.len() });
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    Err("clip file not finalized".into())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreenshotInfo {
    path: String,
    data_url: String,
}

#[tauri::command]
async fn capture_screenshot() -> Result<ScreenshotInfo, String> {
    let dir = std::path::PathBuf::from(IMAGES_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir failed: {}", e))?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let path = dir.join(format!("screen_{}.png", ts));
    let path_str = path.to_string_lossy().into_owned();
    let status = Command::new("/usr/sbin/screencapture")
        .args(["-x", &path_str])
        .status()
        .map_err(|e| format!("screencapture failed: {}", e))?;
    if !status.success() {
        return Err("screencapture exited non-zero".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("read failed: {}", e))?;
    let b64 = general_purpose::STANDARD.encode(&bytes);
    Ok(ScreenshotInfo {
        path: path_str,
        data_url: format!("data:image/png;base64,{}", b64),
    })
}

#[tauri::command]
async fn agent_root() -> Result<String, String> {
    Ok(AGENT_ROOT.to_string())
}

#[tauri::command]
async fn restart_daemon() -> Result<(), String> {
    let _stop = Command::new("/bin/launchctl")
        .args(["stop", LAUNCHD_LABEL])
        .status()
        .map_err(|e| format!("launchctl stop: {}", e))?;
    let start = Command::new("/bin/launchctl")
        .args(["start", LAUNCHD_LABEL])
        .status()
        .map_err(|e| format!("launchctl start: {}", e))?;
    if !start.success() {
        return Err(format!("launchctl start exited with {:?}", start.code()));
    }
    set_active_writer(None);
    Ok(())
}

fn toggle_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let visible = window.is_visible().unwrap_or(false);
        let focused = window.is_focused().unwrap_or(false);

        if visible && focused {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
            if !visible {
                let _ = window.emit("spotlight-shown", ());
            }
        }
    }
}

fn main() {
    let shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::Space);

    tauri::Builder::default()
        // Intentionally NOT using tauri-plugin-window-state — restoring the
        // previous height on launch fights snapToMin and produces a huge
        // empty window on first show. We always want fresh launches to open
        // at the minimum bar height (tauri.conf.json `height: 48`).
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcut(shortcut)
                .expect("register shortcut")
                .with_handler(move |app, sc, event| {
                    if sc == &shortcut && event.state() == ShortcutState::Pressed {
                        toggle_window(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let window = app.get_webview_window("main").expect("main window");

            #[cfg(target_os = "macos")]
            {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

                let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);

                // Light translucent material — matches macOS Spotlight's look:
                // desktop colors visibly bleed through the frosted glass. Was
                // HudWindow (dark), which fought with the warm/light theme.
                let _ = apply_vibrancy(
                    &window,
                    NSVisualEffectMaterial::Sheet,
                    Some(NSVisualEffectState::Active),
                    Some(16.0),
                );

                if let Ok(ns_window) = window.ns_window() {
                    use cocoa::base::{id, nil};
                    use cocoa::foundation::NSString;
                    use objc::{class, msg_send, sel, sel_impl};
                    let ns_window = ns_window as id;
                    unsafe {
                        let name = NSString::alloc(nil).init_str("NSAppearanceNameAqua");
                        let appearance: id = msg_send![class!(NSAppearance), appearanceNamed: name];
                        let _: () = msg_send![ns_window, setAppearance: appearance];
                    }
                }

                // Disable AppKit's implicit window-resize animation so setSize
                // takes effect on the next frame instead of easing over ~200ms.
                // The frontend animates height changes itself when it wants
                // them animated; auto-grow during streaming should be instant.
                if let Ok(ns_window) = window.ns_window() {
                    use cocoa::base::id;
                    use objc::{msg_send, sel, sel_impl};
                    let ns_window = ns_window as id;
                    unsafe {
                        // NSWindowAnimationBehaviorNone = 2
                        let _: () = msg_send![ns_window, setAnimationBehavior: 2_i64];
                    }
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            send_query,
            restart_daemon,
            save_image,
            save_file,
            cancel_query,
            start_fresh_session,
            resume_session,
            interrupt_query,
            open_external,
            open_reply_window,
            read_sessions,
            write_sessions,
            agent_root,
            resize_height,
            read_settings,
            write_settings,
            start_screen_capture,
            stop_screen_capture,
            capture_screenshot,
        ])
        .run(tauri::generate_context!())
        .expect("error while running spotlight");
}
