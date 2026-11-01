import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const exe = process.platform === "win32" ? "fcc-studio.exe" : "fcc-studio";
const app = process.env.SERENITY_BIN ?? join(repo, "src-tauri", "target", "debug", exe);
const DRIVER = "http://127.0.0.1:4444";

if (!existsSync(app)) {
  console.error(`app binary not found at ${app}; run: npx tauri build --debug --no-bundle`);
  process.exit(2);
}

const sandbox = mkdtempSync(join(tmpdir(), "serenity-e2e-"));
const home = join(sandbox, "home");
const project = join(sandbox, "demo-app");
mkdirSync(home, { recursive: true });
mkdirSync(join(project, "src"), { recursive: true });
writeFileSync(join(project, "index.html"), "<!doctype html><html><head><title>Demo</title></head><body><h1 id='hero'>Hello Serenity</h1></body></html>");
writeFileSync(join(project, "src", "app.ts"), "export const greeting = 'hi';\n");
writeFileSync(join(project, "README.md"), "# Demo\n");

const env = {
  ...process.env,
  HOME: home,
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_CONFIG_HOME: join(home, ".config"),
  PATH: `${join(here, "fixtures")}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
  GIT_AUTHOR_NAME: "e2e",
  GIT_AUTHOR_EMAIL: "e2e@example.com",
  GIT_COMMITTER_NAME: "e2e",
  GIT_COMMITTER_EMAIL: "e2e@example.com",
  SHELL: "/bin/bash",
};

const results = [];
let driver;
let sid;

function waitPort(port, timeout = 20000) {
  const end = Date.now() + timeout;
  return new Promise((ok, fail) => {
    const tryOnce = () => {
      const s = net.connect(port, "127.0.0.1");
      s.on("connect", () => {
        s.end();
        ok();
      });
      s.on("error", () => {
        s.destroy();
        if (Date.now() > end) fail(new Error(`port ${port} not ready`));
        else setTimeout(tryOnce, 200);
      });
    };
    tryOnce();
  });
}

async function wd(method, path, body) {
  const res = await fetch(`${DRIVER}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.value?.error) throw new Error(`${method} ${path}: ${JSON.stringify(json.value ?? json)}`);
  return json.value;
}

const s = (p) => `/session/${sid}${p}`;
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
const elId = (v) => v[ELEMENT] ?? v.ELEMENT;

async function exec(script, ...args) {
  return wd("POST", s("/execute/sync"), { script, args });
}

async function execAsync(script, ...args) {
  return wd("POST", s("/execute/async"), { script, args });
}

async function invoke(cmd, payload = {}) {
  return execAsync(
    "const [cmd, payload, done] = arguments; window.__TAURI_INTERNALS__.invoke(cmd, payload).then((v) => done({ ok: v }), (e) => done({ err: String(e) }));",
    cmd,
    payload
  ).then((r) => {
    if (r && "err" in r) throw new Error(`${cmd}: ${r.err}`);
    return r?.ok;
  });
}

async function waitFor(desc, fn, timeout = 15000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${desc}${last ? `: ${last.message}` : ""}`);
}

async function find(xpath, timeout) {
  return waitFor(`element ${xpath}`, async () => {
    const v = await wd("POST", s("/elements"), { using: "xpath", value: xpath });
    return v.length ? elId(v[0]) : null;
  }, timeout);
}

async function click(xpath) {
  const id = await find(xpath);
  await exec("arguments[0].scrollIntoView({block:'center'});", { [ELEMENT]: id });
  await wd("POST", s(`/element/${id}/click`), {});
}

async function type(xpath, text) {
  const id = await find(xpath);
  await wd("POST", s(`/element/${id}/value`), { text });
}

async function bodyText() {
  return exec("return document.body.innerText;");
}

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  ✓ ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`  ✗ ${name}\n      ${e.message}`);
    try {
      const png = await wd("GET", s("/screenshot"));
      const file = join(sandbox, `${name.replace(/\W+/g, "_")}.png`);
      writeFileSync(file, Buffer.from(png, "base64"));
      console.log(`      screenshot: ${file}`);
    } catch {
      return;
    }
  }
}

const tab = (label) => `//div[@role='tablist']//button[normalize-space(.)='${label}' or starts-with(normalize-space(.), '${label}')]`;

async function main() {
  driver = spawn("tauri-driver", [], { env, stdio: ["ignore", "pipe", "pipe"] });
  driver.stderr.on("data", (d) => process.env.E2E_DEBUG && process.stderr.write(d));
  await waitPort(4444);
  const session = await wd("POST", "/session", {
    capabilities: { alwaysMatch: { browserName: "wry", "tauri:options": { application: app } } },
  });
  sid = session.sessionId;
  console.log(`serenity e2e · sandbox ${sandbox}`);

  await step("app boots with title bar and empty state", async () => {
    await waitFor("title bar", async () => (await bodyText()).includes("Serenity"));
    await waitFor("empty state", async () => (await bodyText()).includes("No project open"));
  });

  await step("project created through backend appears after reload", async () => {
    await invoke("create_project", { name: "demo-app", root: project, instructions: "" });
    await exec("location.reload();");
    await waitFor("project in selector", async () => exec("return [...document.querySelectorAll('select option')].some(o => o.textContent === 'demo-app');"));
  });

  await step("file tree lists project files", async () => {
    await find("//span[normalize-space(.)='index.html']");
    await find("//span[normalize-space(.)='src']");
  });

  await step("built-in preview serves the folder with selection overlay", async () => {
    await click(tab("Preview"));
    const src = await waitFor("preview iframe", async () => exec("const f = document.querySelector('iframe[title=\"Live preview\"]'); return f && f.src;"));
    if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(src)) throw new Error(`unexpected iframe src ${src}`);
    const html = await execAsync("const [u, done] = arguments; fetch(u).then(r => r.text()).then(done, e => done('ERR ' + e));", src);
    if (!html.includes("Hello Serenity")) throw new Error("preview did not serve index.html");
    if (!html.includes("data-serenity-preview")) throw new Error("selection overlay was not injected");
    const traversal = await execAsync("const [u, done] = arguments; fetch(u + '..%2f..%2f..%2fetc%2fpasswd').then(r => done(r.status), e => done('ERR'));", src);
    if (traversal !== 404) throw new Error(`path traversal returned ${traversal}`);
  });

  await step("opening a file switches to the editor with its contents", async () => {
    await click("//span[normalize-space(.)='src']");
    await click("//span[normalize-space(.)='app.ts']");
    await waitFor("editor content", async () => exec("const c = document.querySelector('.cm-content'); return c && c.innerText.includes(\"greeting = 'hi'\") && document.querySelector('[role=tab][aria-selected=true]').innerText.startsWith('Editor');"));
  });

  await step("editor live-reloads when the file changes on disk", async () => {
    writeFileSync(join(project, "src", "app.ts"), "export const greeting = 'changed on disk';\n");
    await waitFor("editor refresh", async () => exec("return document.querySelector('.cm-content').innerText.includes('changed on disk');"), 15000);
  });

  await step("editing and saving writes to disk", async () => {
    await exec("const v = document.querySelector('.cm-content'); v.focus();");
    await type("//div[contains(@class,'cm-content')]", "// ");
    await waitFor("dirty marker", async () => (await bodyText()).includes("unsaved"));
    await click("//button[normalize-space(.)='Save']");
    await waitFor("file saved", async () => readFileSync(join(project, "src", "app.ts"), "utf8").includes("// "));
  });

  await step("project search finds matches", async () => {
    await type("//input[@placeholder='Search in project…']", "greeting");
    await waitFor("search hit", async () => (await bodyText()).includes("src/app.ts:1"));
    await click("//input[@placeholder='Search in project…']/following-sibling::button");
  });

  await step("git: init, stage all, commit, history", async () => {
    await click(tab("Git"));
    await click("//button[normalize-space(.)='Initialize repository']");
    await waitFor("changes listed", async () => /changes \(\d+\)/i.test(await bodyText()));
    await click("//button[normalize-space(.)='stage all']");
    await waitFor("staged listed", async () => /staged \(\d+\)/i.test(await bodyText()));
    await type("//input[starts-with(@placeholder,'Commit ')]", "initial import");
    await click("//button[contains(.,'Commit') and not(contains(.,'…'))]");
    await waitFor("commit in history", async () => (await bodyText()).includes("initial import"));
    const log = execFileSync("git", ["-C", project, "log", "--oneline"], { encoding: "utf8" });
    if (!log.includes("initial import")) throw new Error("commit not in git log");
    await new Promise((r) => setTimeout(r, 1500));
    const gitShown = await exec("return [...document.querySelectorAll('span')].some(s => s.textContent === '.git');");
    if (gitShown) throw new Error(".git is listed in the file tree");
  });

  await step("terminal runs a real shell in the project folder", async () => {
    await click(tab("Terminal"));
    await waitFor("xterm mounted", async () => exec("return !!document.querySelector('.xterm-helper-textarea');"));
    await new Promise((r) => setTimeout(r, 1200));
    await exec("document.querySelectorAll('.xterm-helper-textarea').forEach(t => { if (t.closest('[style*=\"inherit\"]')) t.focus(); });");
    const ta = await find("//div[contains(@style,'inherit')]//textarea[contains(@class,'xterm-helper-textarea')]");
    await wd("POST", s(`/element/${ta}/value`), { text: "echo E2E_$((40+2)) && pwd\n" });
    await waitFor("shell output", async () => exec("return [...document.querySelectorAll('.xterm-rows')].some(r => r.innerText.includes('E2E_42'));"), 15000);
    const out = await exec("return [...document.querySelectorAll('.xterm-rows')].map(r => r.innerText).join('\\n');");
    if (!out.includes("demo-app")) throw new Error("shell did not start in project root");
  });

  await step("memory entries persist in the database", async () => {
    await click(tab("Memory"));
    await type("//input[@placeholder='Title']", "Use pnpm");
    await type("//textarea[@placeholder='Details…']", "The project uses pnpm workspaces");
    await click("//button[normalize-space(.)='Add memory']");
    await waitFor("memory listed", async () => (await bodyText()).includes("Use pnpm"));
    const projects = await invoke("list_projects");
    const mem = await invoke("memory_list", { scope: projects[0].id });
    if (!mem.some((m) => m.title === "Use pnpm")) throw new Error("memory not stored");
  });

  await step("hidden panes never paint over the active one", async () => {
    const leaking = await exec("return [...document.querySelectorAll('.xterm')].some(x => { const r = x.getBoundingClientRect(); return r.width > 0 && getComputedStyle(x).visibility === 'visible'; });");
    if (leaking) throw new Error("terminal is visible while another tab is active");
  });

  await step("agent run streams over stdin, renders tools and markdown, persists", async () => {
    await type("//textarea[contains(@placeholder,'Describe what to build')]", "Add a dark mode toggle\uE007");
    await waitFor("streamed reply", async () => (await bodyText()).includes("Echo: Add a dark mode toggle"), 20000);
    const text = await bodyText();
    if (!text.includes("in default mode")) throw new Error("normal autonomy did not map to --permission-mode default");
    if (text.match(/Received \d+ chars in default mode\.\s*Received/)) throw new Error("streamed text duplicated");
    await find("//strong[normalize-space(.)='Add a dark mode toggle']");
    await find("//span[normalize-space(.)='Bash']");
    const order = await exec(`
      const all = document.body.innerText;
      return [all.indexOf("Received"), all.indexOf("echo listing"), all.indexOf("Echo: ")];
    `);
    if (!(order[0] >= 0 && order[0] < order[1] && order[1] < order[2])) throw new Error(`parts out of order: ${order}`);
    await waitFor("run stats", async () => (await bodyText()).includes("2 turns"));
    if (process.env.E2E_SHOTS) writeFileSync(join(process.env.E2E_SHOTS, "agent-run.png"), Buffer.from(await wd("GET", s("/screenshot")), "base64"));
    const projects = await invoke("list_projects");
    const msgs = await invoke("list_messages", { projectId: projects[0].id });
    if (msgs.length < 2) throw new Error("conversation not persisted");
    if (!msgs.some((m) => m.session_id === "e2e-session-1")) throw new Error("session id not stored");
  });

  await step("conversation and session survive an app reload and resume", async () => {
    await exec("location.reload();");
    await waitFor("restored history", async () => (await bodyText()).includes("Echo: Add a dark mode toggle"));
    await find("//span[contains(@class,'chip') and normalize-space(.)='e2e-sess']");
    await type("//textarea[contains(@placeholder,'Describe what to build')]", "second turn\uE007");
    await waitFor("second reply", async () => (await bodyText()).includes("Echo: second turn"), 20000);
  });

  await step("layout and active tab persist", async () => {
    await click(tab("Env"));
    await waitFor("layout saved", async () => {
      const raw = await invoke("kv_get", { key: "layout" });
      return raw && JSON.parse(raw).rightTab === "env";
    });
    await exec("location.reload();");
    await waitFor("env tab restored", async () => exec("const t = document.querySelector('[role=tab][aria-selected=true]'); return t && t.innerText.startsWith('Env');"));
    await waitFor("env detects fixture CLI", async () => (await bodyText()).includes("e2e-fixture"));
  });

  await step("quick open (Ctrl/Cmd+P) fuzzy-finds and opens files", async () => {
    await exec("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }));");
    await type("//div[@aria-label='Quick open']//input", "readme");
    await waitFor("ranked result", async () => exec("const b = document.querySelector('[aria-label=\"Quick open\"] [data-idx=\"0\"]'); return b && b.innerText.includes('README.md');"));
    await type("//div[@aria-label='Quick open']//input", "\uE007");
    await waitFor("README in editor", async () => exec("const c = document.querySelector('.cm-content'); return c && c.innerText.includes('# Demo');"));
  });

  await step("in-app dialogs replace native prompts (new file)", async () => {
    await click("//button[@title='New file']");
    await type("//div[@role='dialog']//input", "notes.txt\uE007");
    await waitFor("file created", async () => existsSync(join(project, "notes.txt")));
    await waitFor("tree shows file", async () => (await bodyText()).includes("notes.txt"));
    await waitFor("untracked badge", async () =>
      exec("const row = [...document.querySelectorAll('span')].find(s => s.textContent === 'notes.txt'); return !!row && row.parentElement.innerText.includes('U');")
    );
  });
}

let code = 0;
try {
  await main();
} catch (e) {
  console.error(e);
  code = 1;
} finally {
  if (sid) await wd("DELETE", `/session/${sid}`).catch(() => {});
  driver?.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} e2e checks passed`);
  if (failed.length) code = 1;
  if (!failed.length && !process.env.E2E_KEEP) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      console.log(`sandbox left at ${sandbox}`);
    }
  }
  process.exit(code);
}
