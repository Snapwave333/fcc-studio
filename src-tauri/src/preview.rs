use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Emitter;

struct Server {
    root: PathBuf,
    port: u16,
    stop: Arc<AtomicBool>,
}

impl Server {
    fn shutdown(&self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect_timeout(
            &SocketAddr::from(([127, 0, 0, 1], self.port)),
            Duration::from_millis(200),
        );
    }
}

#[derive(Default)]
pub struct PreviewState {
    server: Mutex<Option<Server>>,
}

impl PreviewState {
    pub fn stop(&self) {
        if let Ok(mut guard) = self.server.lock() {
            if let Some(s) = guard.take() {
                s.shutdown();
            }
        }
    }
}

const SELECT_SCRIPT: &str = r#"
<script data-serenity-preview>
(function(){
  if (window.__serenityPreview) return;
  window.__serenityPreview = true;
  var enabled = /[?&]__select=1/.test(location.search);
  var box = document.createElement('div');
  box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #F000B8;background:rgba(240,0,184,.12);transition:all .05s;display:none;border-radius:2px';
  var label = document.createElement('div');
  label.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;background:#F000B8;color:#fff;font:600 10px/1.6 ui-monospace,monospace;padding:0 4px;border-radius:2px;display:none';
  function mount(){ document.documentElement.appendChild(box); document.documentElement.appendChild(label); }
  if (document.documentElement) mount(); else document.addEventListener('DOMContentLoaded', mount);
  function hide(){ box.style.display = 'none'; label.style.display = 'none'; }
  function setMode(on){ enabled = !!on; document.documentElement.style.cursor = enabled ? 'crosshair' : ''; if(!enabled) hide(); }
  setMode(enabled);
  window.addEventListener('message', function(e){
    var d = e.data;
    if (d && d.type === 'serenity:select') setMode(d.on);
    if (d && d.type === 'serenity:reload') location.reload();
  });
  document.addEventListener('mousemove', function(e){
    if(!enabled) return;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if(!el || el === box || el === label) return;
    var r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
    box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    label.textContent = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + ' ' + Math.round(r.width) + '×' + Math.round(r.height);
    label.style.display = 'block';
    label.style.left = Math.max(0, r.left) + 'px';
    label.style.top = Math.max(0, r.top - 16) + 'px';
  }, true);
  function selectorFor(el){
    if (el.id) return '#' + CSS.escape(el.id);
    var parts = [], node = el;
    while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
      var sel = node.tagName.toLowerCase();
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      if (node.classList.length) sel += '.' + Array.prototype.slice.call(node.classList, 0, 2).map(function(c){ return CSS.escape(c); }).join('.');
      var parent = node.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function(c){ return c.tagName === node.tagName; });
        if (same.length > 1) sel += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(sel);
      node = parent;
    }
    return parts.join(' > ');
  }
  document.addEventListener('click', function(e){
    if(!enabled) return;
    e.preventDefault(); e.stopPropagation();
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if(!el || el === box || el === label) return;
    var r = el.getBoundingClientRect();
    var payload = {
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      classes: Array.prototype.slice.call(el.classList),
      selector: selectorFor(el),
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160),
      html: el.outerHTML.slice(0, 1200),
      rect: {x: r.x, y: r.y, width: r.width, height: r.height}
    };
    try { window.parent.postMessage({ type: 'serenity:selected', element: payload }, '*'); } catch (_) {}
    fetch('/__select', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) }).catch(function(){});
  }, true);
})();
</script>"#;

pub fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json",
        "webmanifest" => "application/manifest+json",
        "xml" => "application/xml",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "pdf" => "application/pdf",
        "md" => "text/markdown; charset=utf-8",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

pub fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(v) = u8::from_str_radix(hex, 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

pub fn resolve(root: &Path, raw_path: &str) -> Option<PathBuf> {
    let path_part = raw_path.split(['?', '#']).next().unwrap_or("/");
    let decoded = percent_decode(path_part.trim_start_matches('/'));
    let mut target = root.to_path_buf();
    for seg in decoded.split(['/', '\\']) {
        match seg {
            "" | "." => {}
            ".." => return None,
            s if s.contains(':') => return None,
            s => target.push(s),
        }
    }
    let canon_root = root.canonicalize().ok()?;
    if target.is_dir() {
        target = target.join("index.html");
    }
    if target.is_file() {
        let canon = target.canonicalize().ok()?;
        if !canon.starts_with(&canon_root) {
            return None;
        }
        return Some(canon);
    }
    let has_ext = Path::new(&decoded).extension().is_some();
    if !has_ext {
        let fallback = root.join("index.html");
        if fallback.is_file() {
            return fallback.canonicalize().ok();
        }
    }
    None
}

pub fn inject(html: &str) -> String {
    let lower = html.to_lowercase();
    let mut out = html.to_string();
    if let Some(pos) = lower.rfind("</body>") {
        out.insert_str(pos, SELECT_SCRIPT);
    } else {
        out.push_str(SELECT_SCRIPT);
    }
    out
}

struct Request {
    method: String,
    path: String,
    body: Vec<u8>,
}

fn read_request(stream: &mut TcpStream) -> Option<Request> {
    let mut data: Vec<u8> = Vec::with_capacity(4096);
    let mut buf = [0u8; 8192];
    let header_end = loop {
        let n = stream.read(&mut buf).ok()?;
        if n == 0 {
            return None;
        }
        data.extend_from_slice(&buf[..n]);
        if let Some(i) = data.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        if data.len() > 64 * 1024 {
            return None;
        }
    };
    let head = String::from_utf8_lossy(&data[..header_end]).to_string();
    let mut lines = head.lines();
    let first = lines.next()?;
    let mut parts = first.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();
    let content_length = lines
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.trim().parse::<usize>().ok())
        .unwrap_or(0)
        .min(1024 * 1024);
    let mut body = data[header_end + 4..].to_vec();
    while body.len() < content_length {
        let n = stream.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&buf[..n]);
    }
    body.truncate(content_length);
    Some(Request { method, path, body })
}

fn respond(stream: &mut TcpStream, status: &str, ct: &str, body: &[u8], head_only: bool) {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {ct}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    if !head_only {
        let _ = stream.write_all(body);
    }
    let _ = stream.flush();
}

fn serve_connection(mut stream: TcpStream, root: &Path, app: &tauri::AppHandle) {
    let Some(req) = read_request(&mut stream) else { return };

    if req.method == "POST" && req.path.starts_with("/__select") {
        if let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&req.body) {
            let _ = app.emit("preview-select", payload);
        }
        respond(&mut stream, "200 OK", "application/json", b"{}", false);
        return;
    }
    if req.method != "GET" && req.method != "HEAD" {
        respond(&mut stream, "405 Method Not Allowed", "text/plain", b"method not allowed", false);
        return;
    }
    let head_only = req.method == "HEAD";

    let Some(file_path) = resolve(root, &req.path) else {
        let body = b"<html><body style='font-family:system-ui,sans-serif;background:#101014;color:#A8A2B2;padding:2rem'>404 &mdash; not found in preview root</body></html>";
        respond(&mut stream, "404 Not Found", "text/html; charset=utf-8", body, head_only);
        return;
    };

    match std::fs::read(&file_path) {
        Ok(bytes) => {
            let ct = content_type(&file_path);
            if ct.starts_with("text/html") {
                let html = inject(&String::from_utf8_lossy(&bytes));
                respond(&mut stream, "200 OK", ct, html.as_bytes(), head_only);
            } else {
                respond(&mut stream, "200 OK", ct, &bytes, head_only);
            }
        }
        Err(_) => respond(&mut stream, "500 Internal Server Error", "text/plain", b"read error", head_only),
    }
}

#[tauri::command]
pub fn preview_start(
    app: tauri::AppHandle,
    state: tauri::State<PreviewState>,
    root: String,
) -> Result<u16, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("preview root is not a directory: {root}"));
    }
    let mut guard = state.server.lock().map_err(|e| e.to_string())?;
    if let Some(s) = guard.as_ref() {
        if s.root == root_path && !s.stop.load(Ordering::SeqCst) {
            return Ok(s.port);
        }
    }
    if let Some(s) = guard.take() {
        s.shutdown();
    }
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let stop = Arc::new(AtomicBool::new(false));

    let stop_loop = stop.clone();
    let root_loop = root_path.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            if stop_loop.load(Ordering::SeqCst) {
                break;
            }
            let Ok(s) = stream else { continue };
            let app2 = app.clone();
            let root2 = root_loop.clone();
            std::thread::spawn(move || {
                let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
                let _ = s.set_write_timeout(Some(Duration::from_secs(10)));
                serve_connection(s, &root2, &app2);
            });
        }
    });

    *guard = Some(Server { root: root_path, port, stop });
    Ok(port)
}

#[tauri::command]
pub fn preview_state(state: tauri::State<PreviewState>) -> Result<Option<u16>, String> {
    Ok(state.server.lock().map_err(|e| e.to_string())?.as_ref().map(|s| s.port))
}

#[tauri::command]
pub fn preview_stop(state: tauri::State<PreviewState>) -> Result<(), String> {
    state.stop();
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct OpenPort {
    pub port: u16,
    pub title: String,
}

fn page_title(port: u16) -> Option<String> {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_millis(700)).build();
    let resp = agent.get(&format!("http://127.0.0.1:{port}/")).call().ok()?;
    let mut text = String::new();
    resp.into_reader().take(64 * 1024).read_to_string(&mut text).ok()?;
    let lower = text.to_lowercase();
    let start = lower.find("<title")?;
    let open_end = lower[start..].find('>')? + start + 1;
    let end = lower[open_end..].find("</title>")? + open_end;
    Some(text[open_end..end].trim().chars().take(80).collect())
}

pub fn candidate_ports() -> Vec<u16> {
    let mut ports = vec![
        3000u16, 3001, 3002, 4000, 4173, 4200, 4321, 5000, 5001, 5173, 5174, 5175, 5500, 8000, 8001, 8080,
        8081, 8888, 9000, 1234, 6006,
    ];
    if cfg!(debug_assertions) {
        ports.retain(|p| *p != 5173);
    }
    ports
}

#[tauri::command]
pub async fn dev_server_scan(state: tauri::State<'_, PreviewState>) -> Result<Vec<OpenPort>, String> {
    let own = state.server.lock().map_err(|e| e.to_string())?.as_ref().map(|s| s.port);
    tauri::async_runtime::spawn_blocking(move || {
        let handles: Vec<_> = candidate_ports()
            .into_iter()
            .filter(|p| Some(*p) != own)
            .map(|port| {
                std::thread::spawn(move || {
                    let open = TcpStream::connect_timeout(
                        &SocketAddr::from(([127, 0, 0, 1], port)),
                        Duration::from_millis(200),
                    )
                    .is_ok();
                    open.then(|| OpenPort { port, title: page_title(port).unwrap_or_default() })
                })
            })
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok().flatten()).collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn site() -> PathBuf {
        let d = std::env::temp_dir().join(format!("serenity-preview-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(d.join("assets")).unwrap();
        std::fs::write(d.join("index.html"), "<html><body>hi</body></html>").unwrap();
        std::fs::write(d.join("assets").join("app.js"), "console.log(1)").unwrap();
        d
    }

    #[test]
    fn resolves_files_and_spa_routes() {
        let d = site();
        assert!(resolve(&d, "/assets/app.js?v=1").unwrap().ends_with("app.js"));
        assert!(resolve(&d, "/").unwrap().ends_with("index.html"));
        assert!(resolve(&d, "/dashboard/settings").unwrap().ends_with("index.html"));
        assert!(resolve(&d, "/missing.js").is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn blocks_path_traversal() {
        let d = site();
        assert!(resolve(&d, "/../../etc/passwd").is_none());
        assert!(resolve(&d, "/%2e%2e/%2e%2e/etc/passwd").is_none());
        assert!(resolve(&d, "/assets/..%5c..%5csecret.txt").is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn injects_overlay_before_body_close() {
        let out = inject("<html><BODY>x</BODY></html>");
        let script = out.find("data-serenity-preview").unwrap();
        assert!(script < out.find("</BODY>").unwrap());
    }

    #[test]
    fn decodes_percent_sequences() {
        assert_eq!(percent_decode("a%20b%2Fc"), "a b/c");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%4"), "%4");
    }

    #[test]
    fn mime_types_cover_common_assets() {
        assert_eq!(content_type(Path::new("a.wasm")), "application/wasm");
        assert!(content_type(Path::new("A.HTML")).starts_with("text/html"));
    }
}
