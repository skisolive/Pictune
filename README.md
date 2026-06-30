<div align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="96" alt="Pictune" />
  <h1>Pictune</h1>
</div>

**Turn your cover art and audio into a YouTube-ready video — free, offline, no watermark.**

![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Free](https://img.shields.io/badge/price-free-brightgreen)

---

## Why not TunesToTube?

| | TunesToTube | Pictune |
|---|---|---|
| Watermark on video | ✅ free tier | ❌ never |
| Paid plan to remove watermark | $5–9/mo | free forever |
| Your files uploaded to a server | yes | **no — 100% offline** |
| Works without internet | no | **yes** |
| Open source | no | **yes** |

---

## Features

- 🎨 Drop your cover image (JPG, PNG, WEBP)
- 🎵 Add one or more audio files (MP3, WAV) in any order
- ⏱️ See total duration before you render
- 📊 Live progress and ETA while rendering
- 📁 Open output directly in your file manager when done
- 🖥️ 720p and 1080p output
- 🔒 Your files never leave your machine

---

## Download

Grab the latest installer from [**Releases**](../../releases).

| Platform | File |
|---|---|
| Windows | `Pictune_x64-setup.exe` or `.msi` |
| macOS | `Pictune.dmg` — universal, runs on Intel and Apple Silicon |
| Linux | `Pictune.AppImage` or `.deb` |

---

## Building from source

**Prerequisites:** [Rust](https://rustup.rs), [Node.js 20+](https://nodejs.org), and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform.

```bash
git clone https://github.com/skisolive/pictune
cd pictune
npm install
npm run tauri build
```

ffmpeg is downloaded automatically by CI. For local builds, place static ffmpeg and ffprobe binaries in `src-tauri/bin/` named after your platform:

| Platform | Expected filenames |
|---|---|
| Windows x64 | `ffmpeg-windows-x64.exe`, `ffprobe-windows-x64.exe` |
| macOS ARM | `ffmpeg-macos-arm64`, `ffprobe-macos-arm64` |
| macOS Intel | `ffmpeg-macos-x64`, `ffprobe-macos-x64` |
| Linux x64 | `ffmpeg-linux-x64`, `ffprobe-linux-x64` |

Get static builds from [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds/releases) (Windows/Linux) or [evermeet.cx](https://evermeet.cx/ffmpeg/) (macOS).

---

## License

MIT — free to use, modify, and distribute.
