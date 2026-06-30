import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { downloadDir } from "@tauri-apps/api/path";
import "./App.css";

const SETTINGS_KEY = "pictune.settings.v1";

function formatDuration(secs) {
  if (!secs || secs <= 0) return null;
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function HandleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M5 3.25C5 2.83579 4.66421 2.5 4.25 2.5C3.83579 2.5 3.5 2.83579 3.5 3.25C3.5 3.66421 3.83579 4 4.25 4C4.66421 4 5 3.66421 5 3.25Z" fill="currentColor" />
      <path d="M5 8C5 7.58579 4.66421 7.25 4.25 7.25C3.83579 7.25 3.5 7.58579 3.5 8C3.5 8.41421 3.83579 8.75 4.25 8.75C4.66421 8.75 5 8.41421 5 8Z" fill="currentColor" />
      <path d="M5 12.75C5 12.3358 4.66421 12 4.25 12C3.83579 12 3.5 12.3358 3.5 12.75C3.5 13.1642 3.83579 13.5 4.25 13.5C4.66421 13.5 5 13.1642 5 12.75Z" fill="currentColor" />
      <path d="M12.5 3.25C12.5 2.83579 12.1642 2.5 11.75 2.5C11.3358 2.5 11 2.83579 11 3.25C11 3.66421 11.3358 4 11.75 4C12.1642 4 12.5 3.66421 12.5 3.25Z" fill="currentColor" />
      <path d="M12.5 8C12.5 7.58579 12.1642 7.25 11.75 7.25C11.3358 7.25 11 7.58579 11 8C11 8.41421 11.3358 8.75 11.75 8.75C12.1642 8.75 12.5 8.41421 12.5 8Z" fill="currentColor" />
      <path d="M12.5 12.75C12.5 12.3358 12.1642 12 11.75 12C11.3358 12 11 12.3358 11 12.75C11 13.1642 11.3358 13.5 11.75 13.5C12.1642 13.5 12.5 13.1642 12.5 12.75Z" fill="currentColor" />
    </svg>
  );
}

function MusicIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M9 18V6l12-2v12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="6" cy="18" r="3" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="18" cy="16" r="3" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function SortableRow({ id, name, duration, onRemove }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id });
  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <div ref={setNodeRef} style={style} className="audio-row">
      <button className="icon-btn handle" type="button" aria-label="Reorder" {...attributes} {...listeners}>
        <HandleIcon />
      </button>
      <div className="audio-meta">
        <div className="audio-name">{name}</div>
      </div>
      {duration != null ? (
        <span className="duration-badge">{formatDuration(duration)}</span>
      ) : (
        <span className="duration-badge loading">—</span>
      )}
      <button className="icon-btn danger" type="button" onClick={onRemove} aria-label="Remove">×</button>
    </div>
  );
}

function App() {
  const [imagePath, setImagePath] = useState("");
  const [imageThumb, setImageThumb] = useState("");
  const [audioItems, setAudioItems] = useState([]);
  const [outputDir, setOutputDir] = useState("");
  const [outputName, setOutputName] = useState("");
  const [resolution, setResolution] = useState("1080p");
  const [fit, setFit] = useState("contain");
  const [statusMessage, setStatusMessage] = useState("");
  const [currentJobId, setCurrentJobId] = useState("");
  const [queue, setQueue] = useState([]);
  const [dropHint, setDropHint] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [isClosing, setIsClosing] = useState(false);

  const imageZoneRef = useRef(null);
  const audioZoneRef = useRef(null);
  const imagePathRef = useRef("");
  const dropHintRef = useRef(null);
  const startedAtRef = useRef(null);
  const nowRef = useRef(Date.now());

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const audioIds = useMemo(() => audioItems.map((item) => item.id), [audioItems]);

  const totalDurationSecs = useMemo(
    () => audioItems.reduce((sum, item) => sum + (item.duration ?? 0), 0),
    [audioItems]
  );

  // Probe duration for any items missing it
  useEffect(() => {
    const unprobedItems = audioItems.filter((item) => item.duration === undefined);
    if (unprobedItems.length === 0) return;

    unprobedItems.forEach((item) => {
      invoke("probe_audio_duration", { path: item.path })
        .then((secs) => {
          setAudioItems((prev) =>
            prev.map((i) => (i.id === item.id ? { ...i, duration: secs } : i))
          );
        })
        .catch(() => {
          setAudioItems((prev) =>
            prev.map((i) => (i.id === item.id ? { ...i, duration: null } : i))
          );
        });
    });
  }, [audioItems]);

  // Track render start time for ETA
  useEffect(() => {
    const interval = setInterval(() => { nowRef.current = Date.now(); }, 500);
    return () => clearInterval(interval);
  }, []);

  const currentJob = queue.find((item) => item.job_id === currentJobId);
  const currentProgress = currentJob ? currentJob.progress : 0;
  const currentStatus = currentJob ? currentJob.status : "idle";
  const currentOutputPath = currentJob ? currentJob.output_path : "";

  useEffect(() => {
    if (currentStatus === "rendering" && !startedAtRef.current) {
      startedAtRef.current = Date.now();
    } else if (currentStatus !== "rendering") {
      startedAtRef.current = null;
    }
  }, [currentStatus]);

  const [, forceUpdate] = useState(0);
  useEffect(() => {
    if (currentStatus !== "rendering") return;
    const id = setInterval(() => forceUpdate((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [currentStatus]);

  const etaLabel = useMemo(() => {
    if (currentStatus !== "rendering" || currentProgress < 1 || !startedAtRef.current) return null;
    const elapsed = (Date.now() - startedAtRef.current) / 1000;
    const total = elapsed / (currentProgress / 100);
    const remaining = Math.max(0, total - elapsed);
    if (remaining < 5) return "almost done";
    if (remaining < 60) return `~${Math.round(remaining)}s left`;
    return `~${Math.round(remaining / 60)}m left`;
  }, [currentStatus, currentProgress]);

  useEffect(() => {
    const unlistenProgress = listen("render:progress", (event) => {
      const { job_id, percent } = event.payload;
      setQueue((prev) =>
        prev.map((item) =>
          item.job_id === job_id ? { ...item, progress: Math.max(0, Math.min(100, percent)) } : item
        )
      );
    });
    const unlistenComplete = listen("render:complete", (event) => {
      const { job_id, output_path } = event.payload;
      setQueue((prev) =>
        prev.map((item) =>
          item.job_id === job_id ? { ...item, status: "done", progress: 100, output_path } : item
        )
      );
      setStatusMessage("");
    });
    const unlistenError = listen("render:error", (event) => {
      const { job_id, message } = event.payload;
      setQueue((prev) =>
        prev.map((item) =>
          item.job_id === job_id ? { ...item, status: "error", message } : item
        )
      );
      setStatusMessage(message);
    });
    return () => {
      unlistenProgress.then((f) => f());
      unlistenComplete.then((f) => f());
      unlistenError.then((f) => f());
    };
  }, []);

  useEffect(() => { imagePathRef.current = imagePath; }, [imagePath]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!imagePath) { setImageThumb(""); return; }
      try {
        const result = await invoke("image_thumbnail", { path: imagePath });
        if (!cancelled) setImageThumb(result || "");
      } catch {
        if (!cancelled) setImageThumb("");
      }
    })();
    return () => { cancelled = true; };
  }, [imagePath]);

  useEffect(() => {
    (async () => {
      let loadedDir = "";
      try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (raw) {
          const saved = JSON.parse(raw);
          if (typeof saved.outputDir === "string") loadedDir = saved.outputDir;
          if (typeof saved.outputName === "string") setOutputName(saved.outputName);
          if (saved.resolution === "720p" || saved.resolution === "1080p") setResolution(saved.resolution);
          if (saved.fit === "contain" || saved.fit === "cover") setFit(saved.fit);
        }
      } catch { }
      if (!loadedDir) {
        try { loadedDir = await downloadDir(); } catch (err) { console.error(err); }
      }
      if (loadedDir) setOutputDir(loadedDir);
    })();
  }, []);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ outputDir, outputName, resolution, fit }));
  }, [outputDir, outputName, resolution, fit]);

  useEffect(() => {
    let unlisten = null;
    const within = (rect, x, y) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    const zoneAt = (position) => {
      const dpr = window.devicePixelRatio || 1;
      const x = position.x / dpr;
      const y = position.y / dpr;
      const imageRect = imageZoneRef.current?.getBoundingClientRect?.();
      const audioRect = audioZoneRef.current?.getBoundingClientRect?.();
      if (imageRect && within(imageRect, x, y)) return "image";
      if (audioRect && within(audioRect, x, y)) return "audio";
      return null;
    };
    const onDropPaths = (paths, zone) => {
      const imgs = paths.filter((p) => /\.(jpg|jpeg|png|webp)$/i.test(p));
      const audios = paths.filter((p) => /\.(mp3|wav)$/i.test(p));
      if (zone === "image") { if (imgs[0]) setImagePath(imgs[0]); return; }
      if (zone === "audio") { if (audios.length > 0) appendAudioPaths(audios); return; }
      if (!imagePathRef.current && imgs[0]) setImagePath(imgs[0]);
      if (audios.length > 0) appendAudioPaths(audios);
    };
    (async () => {
      try {
        const unlistenEnter = await listen('tauri://drag-enter', (event) => {
          if (event.payload?.position) { const zone = zoneAt(event.payload.position); dropHintRef.current = zone; setDropHint(zone); }
        });
        const unlistenOver = await listen('tauri://drag-over', (event) => {
          if (event.payload?.position) { const zone = zoneAt(event.payload.position); dropHintRef.current = zone; setDropHint(zone); }
        });
        const unlistenDrop = await listen('tauri://drag-drop', (event) => {
          const zone = dropHintRef.current;
          dropHintRef.current = null; setDropHint(null);
          const paths = event.payload?.paths || [];
          onDropPaths(paths, zone);
        });
        const unlistenLeave = await listen('tauri://drag-leave', () => { dropHintRef.current = null; setDropHint(null); });
        unlisten = () => { unlistenEnter(); unlistenOver(); unlistenDrop(); unlistenLeave(); };
      } catch (error) { console.error('Failed to set up drag and drop listener:', error); }
    })();
    return () => { if (unlisten) unlisten(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canRender = imagePath && audioItems.length > 0 && outputDir;

  async function chooseImage() {
    const selected = await invoke("pick_image");
    if (selected) setImagePath(selected);
  }

  async function addAudio() {
    const selected = await invoke("pick_audio_files");
    if (!selected || selected.length === 0) return;
    appendAudioPaths(selected);
  }

  async function chooseOutputDir() {
    const selected = await invoke("pick_output_dir");
    if (selected) setOutputDir(selected);
  }

  function onDragEnd(event) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setAudioItems((items) => {
      const oldIndex = items.findIndex((item) => item.id === active.id);
      const newIndex = items.findIndex((item) => item.id === over.id);
      return arrayMove(items, oldIndex, newIndex);
    });
  }

  function appendAudioPaths(paths) {
    setAudioItems((prev) => {
      const existing = new Set(prev.map((i) => i.path));
      const next = paths
        .filter((p) => p && !existing.has(p))
        .map((path) => ({ id: crypto.randomUUID(), path, name: path.split(/[\\/]/).pop(), duration: undefined }));
      return [...prev, ...next];
    });
  }

  async function startRender() {
    const payload = {
      image_path: imagePath,
      audio_paths: audioItems.map((item) => item.path),
      resolution, fit, output_dir: outputDir, output_name: outputName,
    };
    try {
      const response = await invoke("start_render", { payload });
      setCurrentJobId(response.job_id);
      setQueue((prev) => [
        {
          job_id: response.job_id, status: "rendering", progress: 0,
          output_path: "", message: "", created_at: new Date().toISOString(),
          name: outputName || imagePath.split(/[\\/]/).pop() || "Render",
        },
        ...prev,
      ]);
    } catch (error) {
      setStatusMessage(String(error));
    }
  }

  function resetRender() {
    setCurrentJobId("");
    setStatusMessage("");
  }

  async function cancelRender(job_id) {
    await invoke("cancel_render", { job_id });
    setQueue((prev) => prev.map((item) => item.job_id === job_id ? { ...item, status: "canceled" } : item));
    setStatusMessage("Render canceled.");
  }

  function closeSettings() {
    setIsClosing(true);
    setTimeout(() => { setShowSettings(false); setIsClosing(false); }, 200);
  }

  async function openFile(path) {
    await invoke("reveal_in_folder", { path });
  }

  return (
    <main className="app">
      <header className="topbar">
        <div className="brand">
          <div className="logo"></div>
          <div className="title">Pictune</div>
        </div>
        <div className="meta">
          <button className="icon-btn" type="button" onClick={() => setShowSettings(true)} aria-label="Settings">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
              <path fillRule="evenodd" clipRule="evenodd" d="M15.8964 2.30109C15.3763 2.24998 14.7443 2.24999 13.9741 2.25H13.9741L10.0259 2.25H10.0259C9.25571 2.24999 8.62365 2.24998 8.10357 2.30109C7.55891 2.35461 7.07864 2.46829 6.62404 2.72984C6.16937 2.99144 5.82995 3.34942 5.51044 3.79326C5.20544 4.21693 4.88869 4.76293 4.50285 5.42801L2.54214 8.80762L2.54214 8.80762C2.15475 9.47532 1.83673 10.0235 1.61974 10.5002C1.39243 10.9996 1.25 11.4737 1.25 12C1.25 12.5263 1.39243 13.0004 1.61974 13.4998C1.83673 13.9766 2.15475 14.5247 2.54214 15.1924L4.50282 18.5719C4.88867 19.237 5.20543 19.7831 5.51044 20.2067C5.82995 20.6506 6.16937 21.0086 6.62404 21.2702C7.07864 21.5317 7.55891 21.6454 8.10357 21.6989C8.62366 21.75 9.25573 21.75 10.026 21.75L13.974 21.75C14.7443 21.75 15.3763 21.75 15.8964 21.6989C16.4411 21.6454 16.9214 21.5317 17.376 21.2702C17.8306 21.0086 18.17 20.6506 18.4896 20.2067C18.7945 19.7831 19.1113 19.2371 19.4971 18.5721L19.4971 18.572L21.4579 15.1924L21.4579 15.1923C21.8453 14.5246 22.1633 13.9765 22.3803 13.4998C22.6076 13.0004 22.75 12.5263 22.75 12C22.75 11.4737 22.6076 10.9996 22.3803 10.5002C22.1633 10.0235 21.8453 9.47535 21.4579 8.80767L19.4972 5.42801C19.1113 4.76293 18.7946 4.21694 18.4896 3.79326C18.1701 3.34942 17.8306 2.99144 17.376 2.72984C16.9214 2.46829 16.4411 2.35461 15.8964 2.30109ZM12 15.5C13.933 15.5 15.5 13.933 15.5 12C15.5 10.067 13.933 8.5 12 8.5C10.067 8.5 8.5 10.067 8.5 12C8.5 13.933 10.067 15.5 12 15.5Z" />
            </svg>
          </button>
        </div>
      </header>

      <section className="panel">
        <div ref={imageZoneRef} className={`dropzone ${dropHint === "image" ? "active" : ""}`}>
          <div className="dropzone-head">
            <div className="dropzone-title">Image</div>
            <button className="btn primary" type="button" onClick={chooseImage}>{imagePath ? "Replace" : "Select"}</button>
          </div>
          {imagePath ? (
            <div className="image-row">
              <div className="thumb">
                {imageThumb ? <img src={imageThumb} alt="" /> : <div className="thumb-ph" />}
              </div>
              <div className="mono truncate" title={imagePath}>{imagePath.split(/[\\/]/).pop()}</div>
            </div>
          ) : (
            <div className="empty">
              <div className="empty-icon">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" strokeWidth="1.5" />
                  <circle cx="8.5" cy="8.5" r="1.5" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M3 15l5-4 4 3 3-2.5 6 5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <div>Drop an image here</div>
            </div>
          )}
        </div>

        <div ref={audioZoneRef} className={`dropzone ${dropHint === "audio" ? "active" : ""}`}>
          <div className="dropzone-head">
            <div className="dropzone-title-group">
              <div className="dropzone-title">Audio</div>
              {totalDurationSecs > 0 && (
                <span className="total-duration">{formatDuration(totalDurationSecs)}</span>
              )}
            </div>
            <div className="dropzone-actions">
              {audioItems.length > 0 && (
                <button className="btn" type="button" onClick={() => setAudioItems([])}>Clear</button>
              )}
              <button className="btn primary" type="button" onClick={addAudio}>Add</button>
            </div>
          </div>

          <div className="audio-list">
            {audioItems.length === 0 ? (
              <div className="empty">
                <div className="empty-icon"><MusicIcon /></div>
                <div>Drop MP3 or WAV files here</div>
              </div>
            ) : (
              <DndContext sensors={sensors} onDragEnd={onDragEnd}>
                <SortableContext items={audioIds} strategy={verticalListSortingStrategy}>
                  {audioItems.map((item) => (
                    <SortableRow
                      key={item.id}
                      id={item.id}
                      name={item.name}
                      duration={item.duration}
                      onRemove={() => setAudioItems((prev) => prev.filter((audio) => audio.id !== item.id))}
                    />
                  ))}
                </SortableContext>
              </DndContext>
            )}
          </div>
        </div>

        <div className="export">
          <div className="render">
            <div className="render-top">
              <div className={`status ${currentStatus}`}>
                {currentStatus === "rendering" ? "Rendering" : currentStatus === "idle" && totalDurationSecs > 0 ? `Total · ${formatDuration(totalDurationSecs)}` : currentStatus}
              </div>
              <div className="pct">
                {currentStatus === "rendering" && etaLabel
                  ? etaLabel
                  : currentStatus === "rendering"
                  ? `${currentProgress.toFixed(1)}%`
                  : currentProgress > 0
                  ? `${currentProgress.toFixed(1)}%`
                  : ""}
              </div>
            </div>
            <div className="bar">
              <div className="fill" style={{ width: `${currentProgress}%` }} />
            </div>
            {statusMessage ? (
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 12 }}>{statusMessage}</div>
            ) : null}
            <div className="actions">
              {currentStatus === "done" ? (
                <>
                  <button className="btn" type="button" onClick={() => openFile(currentOutputPath)}>
                    Show in Folder
                  </button>
                  <button className="btn primary" type="button" onClick={resetRender}>
                    New
                  </button>
                </>
              ) : currentStatus === "rendering" ? (
                <button className="btn" type="button" onClick={() => cancelRender(currentJobId)}>Cancel</button>
              ) : (
                <button className="btn primary" type="button" onClick={startRender} disabled={!canRender}>Render</button>
              )}
            </div>
          </div>
        </div>
      </section>

      {showSettings ? (
        <div className={`overlay ${isClosing ? "closing" : ""}`} role="dialog" aria-modal="true" onMouseDown={closeSettings}>
          <div className={`sheet ${isClosing ? "closing" : ""}`} onMouseDown={(e) => e.stopPropagation()}>
            <div className="sheet-head">
              <div className="sheet-title">Settings</div>
              <button className="icon-btn danger" type="button" onClick={closeSettings} aria-label="Close">×</button>
            </div>

            <div className="row" style={{ marginBottom: 16 }}>
              <button
                className="btn"
                type="button"
                onClick={chooseOutputDir}
                style={{ width: "100%", justifyContent: "space-between", paddingRight: 10, height: "auto", minHeight: 32, padding: "8px 16px", background: "var(--bg-app)", border: "1px solid var(--border)" }}
                title={outputDir}
              >
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", overflow: "hidden" }}>
                  <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)" }}>Output Folder</span>
                  <span className="truncate" style={{ fontSize: 12, width: "100%", textAlign: "left", color: outputDir ? "var(--text-main)" : "var(--text-faint)" }}>
                    {outputDir || "Select Folder..."}
                  </span>
                </div>
                <span style={{ opacity: 0.5, fontSize: 18 }}>›</span>
              </button>
            </div>

            <div className="grid2">
              <div>
                <div className="label">Resolution</div>
                <select value={resolution} style={{ marginTop: "8px" }} onChange={(e) => setResolution(e.target.value)}>
                  <option value="720p">1280×720</option>
                  <option value="1080p">1920×1080</option>
                </select>
              </div>
              <div>
                <div className="label">Fit</div>
                <select value={fit} style={{ marginTop: "8px" }} onChange={(e) => setFit(e.target.value)}>
                  <option value="contain">Contain</option>
                  <option value="cover">Cover</option>
                </select>
              </div>
            </div>

            <div className="row">
              <div className="label">Name</div>
              <input value={outputName} onChange={(e) => setOutputName(e.target.value)} placeholder="Optional" style={{ marginLeft: "8px" }} />
            </div>

            <details className="history" open={false}>
              <summary>History ({queue.length})</summary>
              <div className="queue">
                {queue.length === 0 ? (
                  <div className="empty" style={{ border: "none", padding: "12px 0" }}>No renders yet.</div>
                ) : (
                  queue.map((item) => (
                    <div key={item.job_id} className="queue-row">
                      <div className="queue-title">{item.name}</div>
                      <div className="queue-sub truncate" title={item.output_path || item.message}>
                        {item.status}
                        {item.output_path ? ` · ${item.output_path}` : ""}
                        {item.status === "error" && item.message ? ` · ${item.message}` : ""}
                      </div>
                      <div className="queue-bar">
                        <div className="queue-fill" style={{ width: `${item.progress || 0}%` }} />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </details>
          </div>
        </div>
      ) : null}
    </main>
  );
}

export default App;
