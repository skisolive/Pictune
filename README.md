# Pictune

Turn your cover art and audio into a YouTube-ready video — entirely on your machine, no uploads, no accounts.

![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## Why Pictune

Sites like TunesToTube do this in the browser — which means your audio and artwork pass through someone else's servers. Pictune runs fully offline. Your files never leave your computer.

## Features

- Drag and drop your cover image and audio files
- Combine multiple audio files in any order
- 720p and 1080p output with contain or cover fit
- AAC 320kbps audio — ready for YouTube
- Duration preview before you render
- ETA during rendering
- Open output directly in your file manager when done
- No internet connection required

## Download

Grab the latest build for your platform from [Releases](../../releases).

| Platform | File |
|---|---|
| Windows | `Pictune_x64-setup.exe` or `.msi` |
| macOS | `Pictune.dmg` (universal — runs on Intel and Apple Silicon) |
| Linux | `Pictune.AppImage` or `.deb` |

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

## License

MIT
