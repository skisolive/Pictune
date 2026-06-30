use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use std::sync::mpsc;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

#[derive(Clone, Default)]
struct RenderManager {
    children: Arc<Mutex<HashMap<String, Child>>>,
}

#[derive(Deserialize)]
struct RenderPayload {
    image_path: String,
    audio_paths: Vec<String>,
    #[serde(default = "default_resolution")]
    resolution: String,
    #[serde(default = "default_fit")]
    fit: String,
    output_dir: String,
    output_name: String,
}

fn default_resolution() -> String {
    "1080p".to_string()
}

fn default_fit() -> String {
    "contain".to_string()
}

#[derive(Serialize, Clone)]
struct StartRenderResponse {
    job_id: String,
}

#[derive(Serialize, Clone)]
struct RenderProgress {
    job_id: String,
    percent: f64,
    out_time_us: u64,
}

#[derive(Serialize, Clone)]
struct RenderComplete {
    job_id: String,
    output_path: String,
}

#[derive(Serialize, Clone)]
struct RenderError {
    job_id: String,
    message: String,
}

#[tauri::command]
fn pick_image(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = mpsc::channel();
    app.dialog()
        .file()
        .add_filter("Images", &["jpg", "jpeg", "png", "webp"])
        .pick_file(move |file| {
            let _ = tx.send(file);
        });
    let file = rx.recv().map_err(|e| e.to_string())?;
    Ok(file.map(|p| p.to_string()))
}

#[tauri::command]
fn image_thumbnail(app: AppHandle, path: String) -> Result<Option<String>, String> {
    if path.trim().is_empty() {
        return Ok(None);
    }

    // Generate a tiny PNG thumbnail using ffmpeg so the frontend doesn't need filesystem access.
    let ffmpeg = resolve_binary(&app, "ffmpeg")?;
    
    let mut command = Command::new(&ffmpeg);
    command.args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            path.as_str(),
            "-vf",
            // 88x88 with aspect-preserving fit + padding.
            "scale=88:88:force_original_aspect_ratio=decrease,pad=88:88:(ow-iw)/2:(oh-ih)/2:color=black@0",
            "-frames:v",
            "1",
            "-f",
            "image2pipe",
            "-vcodec",
            "png",
            "pipe:1",
        ]);
    
    // On Windows, prevent the console window from appearing
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    
    let output = command
        .output()
        .map_err(|e| format!("Thumbnail generation failed: {e}"))?;


    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Thumbnail generation failed.\n\nffmpeg stderr:\n{}",
            stderr.trim()
        ));
    }

    let encoded = base64::engine::general_purpose::STANDARD.encode(output.stdout);
    Ok(Some(format!("data:image/png;base64,{encoded}")))
}

#[tauri::command]
fn pick_audio_files(app: AppHandle) -> Result<Vec<String>, String> {
    let (tx, rx) = mpsc::channel();
    app.dialog()
        .file()
        .add_filter("Audio", &["mp3", "wav"])
        .pick_files(move |files| {
            let _ = tx.send(files);
        });
    let files = rx.recv().map_err(|e| e.to_string())?;
    Ok(files
        .unwrap_or_default()
        .into_iter()
        .map(|p| p.to_string())
        .collect())
}

#[tauri::command]
fn pick_output_dir(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = mpsc::channel();
    app.dialog().file().pick_folder(move |dir| {
        let _ = tx.send(dir);
    });
    let dir = rx.recv().map_err(|e| e.to_string())?;
    Ok(dir.map(|p| p.to_string()))
}

#[tauri::command]
fn probe_audio_duration(app: AppHandle, path: String) -> Result<f64, String> {
    let ffprobe = resolve_binary(&app, "ffprobe")?;
    let us = probe_duration_us(&ffprobe, &path)?;
    Ok(us as f64 / 1_000_000.0)
}

#[tauri::command]
fn reveal_in_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        // Best-effort: open the containing folder
        let folder = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(path);
        std::process::Command::new("xdg-open")
            .arg(folder)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn cancel_render(state: tauri::State<RenderManager>, job_id: String) -> Result<bool, String> {
    let mut children = state.children.lock().map_err(|_| "Lock error")?;
    if let Some(mut child) = children.remove(&job_id) {
        let _ = child.kill();
        return Ok(true);
    }
    Ok(false)
}

#[tauri::command]
fn start_render(
    app: AppHandle,
    state: tauri::State<RenderManager>,
    payload: RenderPayload,
) -> Result<StartRenderResponse, String> {
    validate_payload(&payload)?;

    let job_id = Uuid::new_v4().to_string();
    let app_handle = app.clone();
    let children = state.children.clone();
    let job_id_clone = job_id.clone();

    tauri::async_runtime::spawn_blocking(move || {
        if let Err(err) = run_render(app_handle, children, &job_id_clone, payload) {
            let _ = app.emit(
                "render:error",
                RenderError {
                    job_id: job_id_clone,
                    message: err,
                },
            );
        }
    });

    Ok(StartRenderResponse { job_id })
}

fn validate_payload(payload: &RenderPayload) -> Result<(), String> {
    if payload.image_path.trim().is_empty() {
        return Err("Image is required.".to_string());
    }
    if payload.audio_paths.is_empty() {
        return Err("At least one audio file is required.".to_string());
    }
    if payload.output_dir.trim().is_empty() {
        return Err("Output folder is required.".to_string());
    }
    let image_ok = has_extension(&payload.image_path, &["jpg", "jpeg", "png", "webp"]);
    if !image_ok {
        return Err("Unsupported image type.".to_string());
    }
    for audio in &payload.audio_paths {
        if !has_extension(audio, &["mp3", "wav"]) {
            return Err("Unsupported audio type.".to_string());
        }
    }
    let output_dir = Path::new(&payload.output_dir);
    if !output_dir.exists() {
        return Err("Output folder does not exist.".to_string());
    }
    if !matches!(payload.fit.as_str(), "contain" | "cover") {
        return Err("Unsupported fit mode.".to_string());
    }
    Ok(())
}

fn has_extension(path: &str, allowed: &[&str]) -> bool {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    allowed.iter().any(|a| *a == ext)
}

fn probe_duration_us(ffprobe: &Path, input: &str) -> Result<u64, String> {
    let mut command = Command::new(ffprobe);
    command.args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            input,
        ]);
    
    // On Windows, prevent the console window from appearing
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    
    let output = command
        .output()
        .map_err(|e| format!("FFprobe failed: {e}"))?;


    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Failed to read audio duration.\n\nffprobe stderr:\n{}",
            stderr.trim()
        ));
    }

    let parsed: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|e| format!("FFprobe output parse error: {e}"))?;

    let duration_s = parsed["format"]["duration"]
        .as_str()
        .unwrap_or("0")
        .parse::<f64>()
        .unwrap_or(0.0);

    if duration_s <= 0.0 {
        return Ok(0);
    }

    Ok((duration_s * 1_000_000.0) as u64)
}

fn build_concat_filter(audio_count: usize) -> String {
    if audio_count <= 1 {
        return "[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[aout]"
            .to_string();
    }

    let mut parts: Vec<String> = Vec::new();
    for idx in 1..=audio_count {
        parts.push(format!(
            "[{idx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a{idx}]"
        ));
    }

    let inputs = (1..=audio_count)
        .map(|idx| format!("[a{idx}]"))
        .collect::<Vec<_>>()
        .join("");

    parts.push(format!("{inputs}concat=n={audio_count}:v=0:a=1[aout]"));
    parts.join(";")
}

fn run_render(
    app: AppHandle,
    children: Arc<Mutex<HashMap<String, Child>>>,
    job_id: &str,
    payload: RenderPayload,
) -> Result<(), String> {
    let ffmpeg = resolve_binary(&app, "ffmpeg")?;
    let ffprobe = resolve_binary(&app, "ffprobe")?;

    // Sum audio durations up-front so we can report progress accurately.
    // ffmpeg progress reports `out_time_us` and `out_time_ms` in MICROseconds.
    let mut total_us: u64 = 0;
    for input in &payload.audio_paths {
        total_us = total_us.saturating_add(probe_duration_us(&ffprobe, input)?);
    }
    if total_us == 0 {
        return Err("Could not determine total audio duration.".to_string());
    }

    let output_name = build_output_name(&payload.output_name, &payload.image_path);
    let output_path = Path::new(&payload.output_dir).join(format!("{output_name}.mp4"));

    let (width, height) = match payload.resolution.as_str() {
        "1080p" => (1920, 1080),
        _ => (1280, 720),
    };
    let audio_bitrate = "320k";
    let scale_filter = match payload.fit.as_str() {
        "cover" => format!(
            "scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height}"
        ),
        _ => format!(
            "scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2"
        ),
    };
    // A still-image video doesn't benefit from high FPS; keeping it low speeds up exports drastically.
    let fps = "1";

    let filter_complex = build_concat_filter(payload.audio_paths.len());

    let mut command = Command::new(&ffmpeg);
    command.arg("-y");
    command.args(["-hide_banner", "-loglevel", "error"]);

    // Inputs: 0 = image, 1..N = audio segments
    command.args(["-loop", "1", "-i"]);
    command.arg(payload.image_path.as_str());
    for input in &payload.audio_paths {
        command.arg("-i");
        command.arg(input.as_str());
    }

    command.arg("-filter_complex");
    command.arg(filter_complex.as_str());

    command.args(["-map", "0:v:0"]);
    command.args(["-map", "[aout]"]);

    command.arg("-vf");
    command.arg(scale_filter.as_str());

    let total_duration_s = total_us as f64 / 1_000_000.0;
    command.args([
        "-c:v",
        "libx264",
        "-tune",
        "stillimage",
        "-preset",
        "veryfast",
        // CRF gives "high quality" without forcing huge files / slow IO like a fixed high bitrate can.
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        audio_bitrate,
        "-r",
        fps,
        "-t",
        &total_duration_s.to_string(),
        "-movflags",
        "+faststart",
        "-progress",
        "pipe:1",
        "-nostats",
    ]);

    command.arg(output_path.to_string_lossy().as_ref());
    command.stdout(Stdio::piped()).stderr(Stdio::piped());

    // On Windows, prevent the console window from appearing
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to start ffmpeg: {e}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let stderr_tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
    let stderr_tail_clone = stderr_tail.clone();
    let stderr_join = stderr.map(|stderr| {
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                let mut tail = stderr_tail_clone.lock().ok();
                if let Some(tail) = tail.as_mut() {
                    tail.push_back(line);
                    while tail.len() > 60 {
                        tail.pop_front();
                    }
                }
            }
        })
    });

    {
        let mut map = children.lock().map_err(|_| "Lock error")?;
        map.insert(job_id.to_string(), child);
    }

    if let Some(stdout) = stdout {
        let reader = BufReader::new(stdout);
        for line in reader.lines().flatten() {
            let out_time_us = line
                .strip_prefix("out_time_us=")
                .or_else(|| line.strip_prefix("out_time_ms="));

            if let Some(value) = out_time_us {
                if let Ok(out_time_us) = value.parse::<u64>() {
                    let percent = ((out_time_us as f64) / (total_us as f64) * 100.0)
                        .max(0.0)
                        .min(100.0);
                    let _ = app.emit(
                        "render:progress",
                        RenderProgress {
                            job_id: job_id.to_string(),
                            percent,
                            out_time_us,
                        },
                    );
                }
            }
        }
    }

    let status = {
        let mut map = children.lock().map_err(|_| "Lock error")?;
        if let Some(child) = map.get_mut(job_id) {
            child
                .wait()
                .map_err(|e| format!("FFmpeg failed to finish: {e}"))?
        } else {
            return Err("Render was canceled.".to_string());
        }
    };

    if let Some(join) = stderr_join {
        let _ = join.join();
    }

    {
        let mut map = children.lock().map_err(|_| "Lock error")?;
        map.remove(job_id);
    }

    if status.success() {
        let _ = app.emit(
            "render:complete",
            RenderComplete {
                job_id: job_id.to_string(),
                output_path: output_path.to_string_lossy().to_string(),
            },
        );
        Ok(())
    } else {
        let tail = stderr_tail
            .lock()
            .ok()
            .map(|t| t.iter().cloned().collect::<Vec<_>>().join("\n"))
            .unwrap_or_default();
        if tail.trim().is_empty() {
            Err("FFmpeg exited with an error.".to_string())
        } else {
            Err(format!("FFmpeg exited with an error.\n\nffmpeg stderr (tail):\n{tail}"))
        }
    }
}

fn resolve_binary(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let file = match (os, arch, name) {
        ("windows", "x86_64", "ffmpeg") => "ffmpeg-windows-x64.exe",
        ("windows", "x86_64", "ffprobe") => "ffprobe-windows-x64.exe",
        ("macos", "x86_64", "ffmpeg") => "ffmpeg-macos-x64",
        ("macos", "x86_64", "ffprobe") => "ffprobe-macos-x64",
        ("macos", "aarch64", "ffmpeg") => "ffmpeg-macos-arm64",
        ("macos", "aarch64", "ffprobe") => "ffprobe-macos-arm64",
        ("linux", "x86_64", "ffmpeg") => "ffmpeg-linux-x64",
        ("linux", "x86_64", "ffprobe") => "ffprobe-linux-x64",
        _ => return Err("Unsupported platform for bundled ffmpeg.".to_string()),
    };

    let mut tried: Vec<String> = Vec::new();
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(p) = app
        .path()
        .resolve(format!("bin/{file}"), tauri::path::BaseDirectory::Resource)
    {
        candidates.push(p);
    }

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("bin").join(file));
        candidates.push(cwd.join("src-tauri").join("bin").join(file));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("bin").join(file));
        }
    }

    for candidate in candidates {
        tried.push(candidate.to_string_lossy().to_string());
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    // Final fallback: use PATH if user has ffmpeg installed system-wide.
    if let Some(path) = find_in_path(if os == "windows" {
        format!("{name}.exe")
    } else {
        name.to_string()
    }) {
        return Ok(path);
    }

    Err(format!(
        "FFmpeg binary not found. Expected `{file}`.\nLooked in:\n- {}",
        tried.join("\n- ")
    ))
}

fn find_in_path(exe_name: String) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(&exe_name);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn build_output_name(output_name: &str, image_path: &str) -> String {
    let trimmed = output_name.trim();
    let mut base = if trimmed.is_empty() {
        Path::new(image_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("render")
            .to_string()
    } else {
        trimmed.to_string()
    };
    if base.to_lowercase().ends_with(".mp4") {
        base = base.trim_end_matches(".mp4").to_string();
    }
    base = sanitize_filename(&base);
    if base.is_empty() {
        base = format!("render_{}", unix_timestamp());
    }
    base
}

fn sanitize_filename(name: &str) -> String {
    let invalid = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    name.chars()
        .map(|c| if invalid.contains(&c) { '_' } else { c })
        .collect::<String>()
        .trim()
        .to_string()
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(RenderManager::default())
        .invoke_handler(tauri::generate_handler![
            pick_image,
            image_thumbnail,
            pick_audio_files,
            pick_output_dir,
            start_render,
            cancel_render,
            probe_audio_duration,
            reveal_in_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
