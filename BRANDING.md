# Serenity Brand Guidelines & Design Kit

> **Official Brand System & Visual Identity for Serenity**  
> *The Autonomous Vibe-Coding Studio for Free Claude Code*

---

## 1. Brand Identity & Vision

**Serenity** represents flow, clarity, and boundless autonomy in software creation. The visual identity pairs a calm, focused human profile with dynamic, energetic fluid paint ripples dissolving backward into speed trails—symbolizing thought turning instantaneously into running software.

---

## 2. Color Palette

Serenity's color scheme is centered around **Electric Fuchsia** on deep obsidian surfaces, delivering high contrast, vivid energy, and an unmistakably modern developer aesthetic.

### Primary Accents

| Token | Hex | RGB | Usage |
|---|---|---|---|
| **Electric Fuchsia** | `#F000B8` | `240, 0, 184` | Primary brand color, logo fluid trails, active tabs, buttons |
| **Neon Fuchsia** | `#FF4FD8` | `255, 79, 216` | Glow accents, hover states, linear gradient stops |
| **Deep Magenta** | `#8E006C` | `142, 0, 108` | Shadows, depth gradients, active borders |
| **Select Wine** | `#512044` | `81, 32, 68` | Subtle selection background, ambient glow wash |

### Studio Surface System (Dark Theme)

| Token | Hex | RGB | Usage |
|---|---|---|---|
| **Obsidian** | `#0A0A0F` | `10, 10, 15` | Window backdrop, terminal cavity, root background |
| **Studio Panel** | `#101014` | `16, 16, 20` | Primary panel container, editor background |
| **Card Surface** | `#191921` | `25, 25, 33` | Navigation panes, dialogs, elevated cards |
| **Elevated Border** | `#22222C` | `34, 34, 44` | Panel splitters, subtle dividers, inactive tabs |
| **Subtle Border** | `#2C2C38` | `44, 44, 56` | Card borders, scrollbars, input outlines |

### Status Colors

| Token | Hex | Usage |
|---|---|---|
| **Emerald OK** | `#39C98A` | Passing tests, agent connected, clean git status |
| **Crimson Error** | `#F15B75` | YOLO autonomy mode, failed tests, compiler errors |
| **Amber Warning** | `#F5A623` | Elevation requests, unsaved diffs |

---

## 3. Typography

- **Display / Wordmark**: *Inter* or *Segoe UI Variable Display*, Bold 800/900 with generous tracking (`letter-spacing: 0.08em`).
- **User Interface**: `system-ui`, `-apple-system`, `Segoe UI`, `Roboto`, `Helvetica Neue`. Clean, legible, 12px floor for microcopy.
- **Code & Terminals**: `JetBrains Mono`, `Cascadia Code`, `Fira Code`, or `monospace`.

---

## 4. Logo Anatomy & Usage Guidelines

### Master Assets

- **Logo Emblem**: A serene left-facing profile silhouette dissolving into energetic, aerodynamic fluid paint splashes trailing backwards to the right.
- **Orientation**: Always facing **left** (toward the user's prompt and intention) with dynamic ripples trailing **right** (toward execution and generated output).
- **Clear Space**: Maintain minimum padding equal to 25% of the emblem's width around all sides.
- **Minimum Size**:
  - Application icon: `16x16 px`
  - In-app title bar emblem: `18x18 px`
  - Standalone emblem: `32x32 px`

### Variations Included in Asset Kit

1. `assets/serenity-logo-transparent.png` (1024×1024 master transparent PNG)
2. `assets/serenity-logo-dark.png` (1024×1024 on obsidian background)
3. `assets/serenity-app-icon.png` (1024×1024 squircle tile with neon rim)
4. `assets/serenity-wordmark-dark.svg` (Horizontal dark theme wordmark)
5. `assets/serenity-wordmark-light.svg` (Horizontal light theme wordmark)
6. `assets/serenity-banner.svg` (1280×440 GitHub README hero banner)
7. `src-tauri/icons/icon.ico` (Multi-resolution Windows desktop executable icon)
8. `public/favicon.ico` & `public/apple-touch-icon.png` (Web & browser icons)

### Do's & Don'ts

- **DO** use the transparent emblem over dark surfaces (`#0a0a0f`, `#101014`, `#191921`) or pure white backgrounds.
- **DO** preserve the vibrant electric fuchsia palette (`#F000B8` to `#FF4FD8`).
- **DO** pair the emblem with clean uppercase typography.
- **DON'T** revert the silhouette to pure black.
- **DON'T** stretch, squeeze, or alter the aspect ratio of the silhouette.
- **DON'T** flip the silhouette horizontally (the face must face left, splashes trailing right).
