use serde::Serialize;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Emitter;

struct Server {
    port: u16,
    root: PathBuf,
    stop: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct PreviewState {
    server: Mutex<Option<Server>>,
}

impl PreviewState {
    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.server.lock() {
            if let Some(server) = guard.take() {
                stop_server(&server);
            }
        }
    }
}

fn stop_server(server: &Server) {
    server.stop.store(true, Ordering::SeqCst);
    let _ = TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], server.port)),
        Duration::from_millis(200),
    );
}

const SELECT_SCRIPT: &str = r#"
<script>
(function(){
  if (window.__fccSelectInstalled) return;
  window.__fccSelectInstalled = true;
  var enabled = location.search.indexOf('__select=1') !== -1;
  var box = document.createElement('div');
  box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #F000B8;background:rgba(240,0,184,.12);transition:all .05s;display:none';
  document.documentElement.appendChild(box);
  function setMode(on){ enabled = !!on; if(!enabled) box.style.display = 'none'; document.documentElement.style.cursor = enabled ? 'crosshair' : ''; }
  setMode(enabled);
  window.addEventListener('message', function(e){
    if (e.data && typeof e.data === 'object' && '__fccSelect' in e.data) setMode(e.data.__fccSelect);
  });
  document.addEventListener('mousemove', function(e){
    if(!enabled) return;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if(!el || el === box) return;
    var r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
  }, true);
  function selectorFor(el){
    if (el.id) return '#' + CSS.escape(el.id);
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      var sel = node.tagName.toLowerCase();
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      if (node.classList.length) sel += '.' + Array.from(node.classList).slice(0,2).map(function(c){ return CSS.escape(c); }).join('.');
      var parent = node.parentElement;
      if (parent) {
        var same = Array.from(parent.children).filter(function(c){ return c.tagName === node.tagName; });
        if (same.length > 1) sel += ':nth-of-type(' + (same.indexOf(node)+1) + ')';
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
    if(!el || el === box) return;
    var r = el.getBoundingClientRect();
    fetch('/__select', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        classes: Array.from(el.classList),
        selector: selectorFor(el),
        text: (el.textContent || '').trim().slice(0, 160),
        html: el.outerHTML.slice(0, 1200),
        rect: {x: r.x, y: r.y, width: r.width, height: r.height}
      })
    }).catch(function(){});
  }, true);
  window.__setSelectMode = setMode;
})();
</script>"#;

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json",
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
        "xml" => "application/xml",
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
            if let Ok(v) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16) {
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

pub fn resolve_request_path(root: &Path, raw_path: &str) -> Option<PathBuf> {
    let path_part = raw_path.split(['?', '#']).next().unwrap_or("/");
    let decoded = percent_decode(path_part.trim_start_matches('/'));
    let mut resolved = root.to_path_buf();
    for component in Path::new(&decoded).components() {
        match component {
            Component::Normal(part) => resolved.push(part),
            Component::CurDir => {}
            _ => return None,
        }
    }
    if decoded.is_empty() || decoded.ends_with('/') || resolved.is_dir() {
        resolved.push("index.html");
    }
    Some(resolved)
}

fn respond(stream: &mut TcpStream, status: &str, content_type: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

fn read_request(stream: &mut TcpStream) -> Option<(String, String, Vec<u8>)> {
    let mut data = Vec::new();
    let mut buf = [0u8; 8192];
    let header_end = loop {
        let n = stream.read(&mut buf).ok()?;
        if n == 0 {
            return None;
        }
        data.extend_from_slice(&buf[..n]);
        if let Some(pos) = data.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos;
        }
        if data.len() > 64 * 1024 {
            return None;
        }
    };
    let head = String::from_utf8_lossy(&data[..header_end]).to_string();
    let mut lines = head.lines();
    let mut first = lines.next()?.split_whitespace();
    let method = first.next()?.to_string();
    let path = first.next()?.to_string();
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
    Some((method, path, body))
}

fn inject_select_script(bytes: &[u8]) -> Vec<u8> {
    let mut html = String::from_utf8_lossy(bytes).to_string();
    match html.to_ascii_lowercase().rfind("</body>") {
        Some(pos) => html.insert_str(pos, SELECT_SCRIPT),
        None => html.push_str(SELECT_SCRIPT),
    }
    html.into_bytes()
}

fn serve_connection<R: tauri::Runtime>(mut stream: TcpStream, root: &Path, app: &tauri::AppHandle<R>) {
    let Some((method, raw_path, body)) = read_request(&mut stream) else {
        return;
    };

    if method == "POST" && raw_path.starts_with("/__select") {
        if let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&body) {
            let _ = app.emit("preview-select", payload);
        }
        respond(&mut stream, "200 OK", "application/json", b"{}");
        return;
    }

    if method != "GET" && method != "HEAD" {
        respond(&mut stream, "405 Method Not Allowed", "text/plain", b"method not allowed");
        return;
    }

    let Some(mut file_path) = resolve_request_path(root, &raw_path) else {
        respond(&mut stream, "403 Forbidden", "text/plain", b"forbidden");
        return;
    };

    if !file_path.is_file() {
        let fallback = root.join("index.html");
        let looks_like_asset = file_path.extension().map(|e| e != "html").unwrap_or(false);
        if fallback.is_file() && !looks_like_asset {
            file_path = fallback;
        } else {
            let page = b"<html><body style='font-family:sans-serif;background:#101014;color:#A8A2B2;padding:2rem'>404 - not found in preview root</body></html>";
            respond(&mut stream, "404 Not Found", "text/html; charset=utf-8", page);
            return;
        }
    }

    match std::fs::read(&file_path) {
        Ok(bytes) => {
            let ct = content_type(&file_path);
            let payload = if ct.starts_with("text/html") { inject_select_script(&bytes) } else { bytes };
            if method == "HEAD" {
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {ct}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    payload.len()
                );
                let _ = stream.write_all(head.as_bytes());
            } else {
                respond(&mut stream, "200 OK", ct, &payload);
            }
        }
        Err(_) => respond(&mut stream, "500 Internal Server Error", "text/plain", b"read error"),
    }
}

#[tauri::command]
pub fn preview_start<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, PreviewState>,
    root: String,
) -> Result<u16, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("preview root is not a directory: {root}"));
    }
    let mut guard = state.server.lock().map_err(|e| e.to_string())?;
    if let Some(existing) = guard.as_ref() {
        if existing.root == root_path {
            return Ok(existing.port);
        }
        stop_server(existing);
        *guard = None;
    }

    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let stop = Arc::new(AtomicBool::new(false));
    *guard = Some(Server {
        port,
        root: root_path.clone(),
        stop: stop.clone(),
    });
    drop(guard);

    std::thread::spawn(move || {
        for stream in listener.incoming() {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            let Ok(s) = stream else { break };
            let app2 = app.clone();
            let root2 = root_path.clone();
            std::thread::spawn(move || {
                let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
                serve_connection(s, &root2, &app2);
            });
        }
    });

    Ok(port)
}

#[derive(Debug, Clone, Serialize)]
pub struct PreviewInfo {
    pub port: u16,
    pub root: String,
}

#[tauri::command]
pub fn preview_state(state: tauri::State<PreviewState>) -> Result<Option<PreviewInfo>, String> {
    Ok(state.server.lock().map_err(|e| e.to_string())?.as_ref().map(|s| PreviewInfo {
        port: s.port,
        root: s.root.to_string_lossy().to_string(),
    }))
}

#[tauri::command]
pub fn preview_stop(state: tauri::State<PreviewState>) -> Result<(), String> {
    state.shutdown();
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct OpenPort {
    pub port: u16,
}

const DEV_PORTS: [u16; 14] = [5173, 5174, 3000, 3001, 4200, 4321, 8000, 8080, 8081, 8888, 1420, 9000, 4173, 5000];

#[tauri::command]
pub async fn dev_server_scan() -> Result<Vec<OpenPort>, String> {
    let handles: Vec<_> = DEV_PORTS
        .iter()
        .map(|&port| {
            std::thread::spawn(move || {
                TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(200))
                    .is_ok()
                    .then_some(OpenPort { port })
            })
        })
        .collect();
    Ok(handles.into_iter().filter_map(|h| h.join().ok().flatten()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::{Listener, Manager};

    fn http(port: u16, raw: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.write_all(raw.as_bytes()).unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        out
    }

    #[test]
    fn serves_files_blocks_traversal_and_emits_selection() {
        let root = std::env::temp_dir().join(format!("fcc-preview-{}", uuid::Uuid::new_v4()));
        let other = std::env::temp_dir().join(format!("fcc-preview-b-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("css")).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(root.join("index.html"), "<html><body><h1>Hi</h1></body></html>").unwrap();
        std::fs::write(root.join("css/app.css"), "h1{color:red}").unwrap();
        std::fs::write(other.join("index.html"), "<html><body>other</body></html>").unwrap();

        let app = tauri::test::mock_app();
        app.manage(PreviewState::default());
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        app.listen_any("preview-select", move |e| {
            let _ = tx.send(e.payload().to_string());
        });

        let r = root.to_string_lossy().to_string();
        let port = preview_start(app.handle().clone(), app.state::<PreviewState>(), r.clone()).unwrap();
        assert_eq!(preview_start(app.handle().clone(), app.state::<PreviewState>(), r).unwrap(), port);

        let index = http(port, "GET / HTTP/1.1\r\nHost: x\r\n\r\n");
        assert!(index.starts_with("HTTP/1.1 200"));
        assert!(index.contains("<h1>Hi</h1>") && index.contains("__fccSelectInstalled"));
        let css = http(port, "GET /css/app.css?v=2 HTTP/1.1\r\n\r\n");
        assert!(css.contains("text/css") && css.ends_with("h1{color:red}"));
        assert!(http(port, "GET /../../etc/passwd HTTP/1.1\r\n\r\n").starts_with("HTTP/1.1 403"));
        assert!(http(port, "GET /missing.png HTTP/1.1\r\n\r\n").starts_with("HTTP/1.1 404"));
        assert!(http(port, "GET /some/route HTTP/1.1\r\n\r\n").contains("<h1>Hi</h1>"));

        let body = r#"{"tag":"h1","id":"","classes":[],"selector":"h1","text":"Hi","html":"<h1>Hi</h1>","rect":{"x":0,"y":0,"width":1,"height":1}}"#;
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let head = format!("POST /__select HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n", body.len());
        s.write_all(head.as_bytes()).unwrap();
        std::thread::sleep(Duration::from_millis(50));
        s.write_all(body.as_bytes()).unwrap();
        let mut resp = String::new();
        let _ = s.read_to_string(&mut resp);
        assert!(resp.starts_with("HTTP/1.1 200"));
        let selected = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(selected.contains("\"selector\":\"h1\""));

        let o = other.to_string_lossy().to_string();
        let port2 = preview_start(app.handle().clone(), app.state::<PreviewState>(), o).unwrap();
        assert_ne!(port, port2);
        assert!(http(port2, "GET / HTTP/1.1\r\n\r\n").contains("other"));
        std::thread::sleep(Duration::from_millis(100));
        assert!(TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(300))
            .map(|mut s| {
                let _ = s.write_all(b"GET / HTTP/1.1\r\n\r\n");
                let mut out = String::new();
                let _ = s.read_to_string(&mut out);
                out.is_empty()
            })
            .unwrap_or(true));

        preview_stop(app.state::<PreviewState>()).unwrap();
        assert!(preview_state(app.state::<PreviewState>()).unwrap().is_none());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[test]
    fn decodes_percent_sequences() {
        assert_eq!(percent_decode("a%20b"), "a b");
        assert_eq!(percent_decode("caf%C3%A9"), "café");
        assert_eq!(percent_decode("bad%zz"), "bad%zz");
        assert_eq!(percent_decode("tail%2"), "tail%2");
        assert_eq!(percent_decode("end%"), "end%");
    }

    #[test]
    fn blocks_path_traversal() {
        let root = std::env::temp_dir();
        assert!(resolve_request_path(&root, "/../secret").is_none());
        assert!(resolve_request_path(&root, "/a/%2e%2e/%2e%2e/secret").is_none());
        assert_eq!(resolve_request_path(&root, "/").unwrap(), root.join("index.html"));
        assert_eq!(resolve_request_path(&root, "/css/app.css?v=1").unwrap(), root.join("css").join("app.css"));
    }

    #[test]
    fn injects_script_before_body_close() {
        let out = String::from_utf8(inject_select_script(b"<html><BODY>x</BODY></html>")).unwrap();
        let script = out.find("__fccSelectInstalled").unwrap();
        assert!(script < out.find("</BODY>").unwrap());
    }
}
