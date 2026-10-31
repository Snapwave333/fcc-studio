use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use tauri::Emitter;

#[derive(Default)]
pub struct PreviewState {
    pub listener: Mutex<Option<TcpListener>>,
    pub port: Mutex<Option<u16>>,
}

const SELECT_SCRIPT: &str = r#"
<script>
(function(){
  if (!location.search.includes('__select=1')) return;
  let enabled = true, hovered = null, box = null;
  box = document.createElement('div');
  box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #F000B8;background:rgba(240,0,184,.12);transition:all .05s;display:none';
  document.documentElement.appendChild(box);
  document.addEventListener('mousemove', function(e){
    if(!enabled) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if(!el || el === box) return;
    hovered = el;
    const r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
  }, true);
  function selectorFor(el){
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      let sel = node.tagName.toLowerCase();
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      if (node.classList.length) sel += '.' + Array.from(node.classList).slice(0,2).map(c => CSS.escape(c)).join('.');
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter(c => c.tagName === node.tagName);
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
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if(!el || el === box) return;
    const r = el.getBoundingClientRect();
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
  window.__setSelectMode = function(on){ enabled = on; if(!on) box.style.display = 'none'; };
})();
</script>"#;

fn content_type(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "md" => "text/markdown; charset=utf-8",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn serve_connection(mut stream: TcpStream, root: &std::path::Path, app: &tauri::AppHandle) {
    let mut buf = [0u8; 8192];
    let n = match stream.read(&mut buf) {
        Ok(n) if n > 0 => n,
        _ => return,
    };
    let req = String::from_utf8_lossy(&buf[..n]).to_string();
    let first_line = req.lines().next().unwrap_or("").to_string();
    let parts: Vec<&str> = first_line.split_whitespace().collect();
    if parts.len() < 2 {
        return;
    }
    let method = parts[0];
    let raw_path = parts[1];

    if method == "POST" && raw_path.starts_with("/__select") {
        // find body after \r\n\r\n
        if let Some(idx) = req.find("\r\n\r\n") {
            let body = &req[idx + 4..];
            if let Ok(payload) = serde_json::from_str::<serde_json::Value>(body.trim()) {
                let _ = app.emit("preview-select", payload);
            }
        }
        let resp = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}";
        let _ = stream.write_all(resp.as_bytes());
        let _ = stream.flush();
        return;
    }

    // strip query
    let path_part = raw_path.split('?').next().unwrap_or("/");
    let rel = path_part.trim_start_matches('/');
    let decoded = percent_decode(rel);
    let mut file_path = root.join(&decoded);
    if decoded.is_empty() || decoded.ends_with('/') {
        file_path = root.join(&decoded).join("index.html");
    }
    if !file_path.exists() && !file_path.is_file() {
        // SPA fallback: serve index.html when it exists
        let fallback = root.join("index.html");
        if fallback.is_file() {
            file_path = fallback;
        } else {
            let body = b"<html><body style='font-family:sans-serif;background:#101014;color:#A8A2B2;padding:2rem'>404 - not found in preview root</body></html>";
            let resp = format!(
                "HTTP/1.1 404 NOT FOUND\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.write_all(body);
            let _ = stream.flush();
            return;
        }
    }

    match std::fs::read(&file_path) {
        Ok(bytes) => {
            let ct = content_type(&file_path);
            let final_bytes = if ct.starts_with("text/html") {
                let mut html = String::from_utf8_lossy(&bytes).to_string();
                if let Some(pos) = html.to_lowercase().rfind("</body>") {
                    html.insert_str(pos, SELECT_SCRIPT);
                } else {
                    html.push_str(SELECT_SCRIPT);
                }
                html.into_bytes()
            } else {
                bytes
            };
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
                ct,
                final_bytes.len()
            );
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(&final_bytes);
            let _ = stream.flush();
        }
        Err(_) => {
            let resp = "HTTP/1.1 500 ERROR\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.flush();
        }
    }
}

fn percent_decode(s: &str) -> String {
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

#[tauri::command]
pub fn preview_start(
    app: tauri::AppHandle,
    state: tauri::State<PreviewState>,
    root: String,
) -> Result<u16, String> {
    {
        let port_guard = state.port.lock().map_err(|e| e.to_string())?;
        if let Some(p) = *port_guard {
            return Ok(p);
        }
    }
    let root_path = std::path::PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("preview root is not a directory: {root}"));
    }
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    {
        let mut l = state.listener.lock().map_err(|e| e.to_string())?;
        *l = Some(listener.try_clone().map_err(|e| e.to_string())?);
    }
    let mut p = state.port.lock().map_err(|e| e.to_string())?;
    *p = Some(port);
    drop(p);

    let app_handle = app.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(s) => {
                    let app2 = app_handle.clone();
                    let root2 = root_path.clone();
                    std::thread::spawn(move || {
                        let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(5)));
                        serve_connection(s, &root2, &app2);
                    });
                }
                Err(_) => break,
            }
        }
    });

    Ok(port)
}

#[tauri::command]
pub fn preview_state(state: tauri::State<PreviewState>) -> Result<Option<u16>, String> {
    Ok(*state.port.lock().map_err(|e| e.to_string())?)
}

#[tauri::command]
pub fn preview_stop(state: tauri::State<PreviewState>) -> Result<(), String> {
    *state.listener.lock().map_err(|e| e.to_string())? = None;
    *state.port.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct OpenPort {
    pub port: u16,
}

#[tauri::command]
pub fn dev_server_scan() -> Result<Vec<OpenPort>, String> {
    let candidates = [3000u16, 4200, 5173, 8000, 8080, 8081, 8888, 1420, 9000];
    let mut open = Vec::new();
    for port in candidates {
        if TcpStream::connect_timeout(
            &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
            std::time::Duration::from_millis(150),
        )
        .is_ok()
        {
            open.push(OpenPort { port });
        }
    }
    Ok(open)
}
