<div align="center">

<img src="assets/serenity-banner.svg" alt="Serenity Studio Banner" width="100%">

<br/>

[![Status: Active](https://img.shields.io/badge/Status-Active-f000b8.svg?style=for-the-badge)](#)
[![Stack: Tauri v2](https://img.shields.io/badge/Desktop-Tauri_v2-24c8db.svg?style=for-the-badge&logo=tauri&logoColor=white)](https://tauri.app/)
[![Frontend: React + Vite](https://img.shields.io/badge/Frontend-React_18_%2B_Vite-61dafb.svg?style=for-the-badge&logo=react&logoColor=black)](https://vitejs.dev/)
[![Styling: Tailwind v4](https://img.shields.io/badge/Styling-Tailwind_v4-38b2ac.svg?style=for-the-badge&logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-2e7d32.svg?style=for-the-badge)](../free-claude-code/LICENSE)

<br/>

**Serenity** is an autonomous vibe-coding desktop studio built on top of [Free Claude Code](../free-claude-code/).  
It combines an ultra-fast native desktop shell with autonomous agent workflows, live multi-tab terminal multiplexing, an embedded web/app preview engine, git stage/commit controls, and redline performance benchmarking.

<br/>

[Quick Start](#quick-start) • [Features](#key-features) • [Brand Kit](BRANDING.md) • [Architecture](#architecture)

</div>

---

## Key Features

- **Autonomous Agent Control & Elevation:** Run AI coding agents with configurable autonomy modes (`Normal`, `Redline`, `YOLO`) with emergency stop triggers and elevation safeguards.
- **Embedded Web & Dev Server Preview:** Automatically scans and detects local dev server ports (Vite, Next.js, FastAPI, Flask) and renders live hot-reloaded previews directly in the studio side panel.
- **PTY Terminal Multiplexer:** High-performance native pseudo-terminals backed by `portable-pty` and `@xterm/xterm` with automatic fit addon and clean ANSI rendering.
- **Native Git Integration:** Full stage, unstage, discard, commit, diff, and branch management without leaving the workspace.
- **Memory & Context Cache:** Local SQLite memory store (`fcc-studio.db`) for agent learnings, rules, preferences, and session persistence.
- **Redline Engine & Local Models:** Built-in Ollama / local model management, benchmark suites, and leaderboard tracker.

---

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://www.rust-lang.org/tools/install) (stable toolchain with Cargo)
- [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (on Windows)

### Development

```bash
# Clone the repository
cd fcc-studio

# Install dependencies
npm install

# Run Vite dev server + Tauri desktop window
npm run tauri dev
```

### Production Build

```bash
# Build optimized desktop binary
npm run tauri build
```

The resulting standalone executable will be located in `src-tauri/target/release/serenity.exe`.

---

## Design System & Brand Identity

Serenity follows the **Electric Fuchsia** design system. Read the complete visual identity guidelines, logo anatomy, color tokens, and icon usage in [BRANDING.md](BRANDING.md).

<div align="center">
  <img src="assets/serenity-wordmark-dark.svg" alt="Serenity Wordmark" width="540">
  <br/><br/>
  <p>Crafted with 💖 by <b>snapwave//Lushapps</b></p>
</div>
