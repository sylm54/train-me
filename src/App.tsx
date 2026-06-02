import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

// ============================================================================
// Types
// ============================================================================

interface TrackInfo {
  name: string;
  filename: string;
  path: string;
  duration: number;
  created: string;
  size_bytes: number;
}

interface ModelStatus {
  downloaded: boolean;
  loaded: boolean;
  missing_files: string[];
  speakers: string[];
}

interface SynthesizeRequest {
  text: string;
  name: string | null;
}

// ============================================================================
// App
// ============================================================================

function App() {
  const [text, setText] = useState(
    [
      '<voice speaker="male" pitch="1.1" volume="@fadein(2)" speed="1.0">',
      '  <tone type="binaural" preset="theta" volume="0.15"/>',
      "",
      "  Welcome to the comprehensive TTS demonstration.",
      '  <pause duration="0.5"/>',
      '  <sound type="ding" volume="0.8"/>',
      "",
      '  <speed value="0.9">',
      '    <volume value="@fade(1)">',
      "      This part is slightly slower and fades in and out.",
      "    </volume>",
      "  </speed>",
      "",
      "  <overlay>",
      '    <part looped="true" volume="0.4"><sound type="water_drop"/></part>',
      "    <part>And here is an overlay with a looping sound under speech.</part>",
      "  </overlay>",
      "",
      '  <effect type="reverb" preset="large_hall">',
      '    <voice speaker="female" volume="0.9">',
      "      This voice has reverb applied.",
      "    </voice>",
      "  </effect>",
      "",
      '  <effect type="filter" preset="lowpass" cutoff="800">',
      '    <voice speaker="female2">',
      "      And this voice is filtered.",
      "    </voice>",
      "  </effect>",
      "",
      '  <loop loops="2">',
      '    <voice speaker="male2" speed="1.2" volume="@ramp(0.5,1.0)">',
      "      Repeated phrase.",
      "    </voice>",
      '    <pause duration="0.3"/>',
      "  </loop>",
      "",
      '  <background volume="@env(0.2,0.3,0.5,0.2)"><sound type="swoosh" volume="0.5"/></background>',
      "  Now take a deep breath and let it go.",
      '  <pause duration="0.5"/>',
      "",
      '  <voice speaker="female" volume="@min(1.0, @max(0.3, @beat(60, 0.5)))">',
      "    This voice pulses with a beat at sixty B P M.",
      "  </voice>",
      "",
      '  <voice speaker="male" volume="@sin(2) * 0.5 + 0.5">',
      "    This voice oscillates with a sine wave.",
      "  </voice>",
      "",
      '  <until button="I\'m ready"',
      '         waiting-sound="heart_beat"',
      '         waiting-sound-volume="0.4"',
      '         pre-pause="0.5"',
      '         post-pause="0.3">',
      "    Press the button when you are ready.",
      "  </until>",
      "",
      '  <sound type="success"/>',
      '  <voice speaker="female" volume="@fadeout(1)">',
      "    Thank you for exploring every feature. Goodbye.",
      "  </voice>",
      "</voice>",
    ].join("\n"),
  );
  const [trackName, setTrackName] = useState("");
  const [tracks, setTracks] = useState<TrackInfo[]>([]);
  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playingTrack, setPlayingTrack] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  // ── Model status ──────────────────────────────────────────────────
  const refreshModelStatus = useCallback(async () => {
    try {
      const status = await invoke<ModelStatus>("get_model_status");
      setModelStatus(status);
    } catch (e) {
      console.error("Failed to get model status:", e);
    }
  }, []);

  // ── Track list ────────────────────────────────────────────────────
  const refreshTracks = useCallback(async () => {
    try {
      const list = await invoke<TrackInfo[]>("list_tracks");
      setTracks(list);
    } catch (e) {
      console.error("Failed to list tracks:", e);
    }
  }, []);

  useEffect(() => {
    refreshModelStatus();
    refreshTracks();
  }, [refreshModelStatus, refreshTracks]);

  // ── Auto-load model if downloaded ─────────────────────────────────
  useEffect(() => {
    if (modelStatus?.downloaded && !modelStatus?.loaded) {
      invoke("load_model")
        .then(() => refreshModelStatus())
        .catch((e) => console.error("Auto-load failed:", e));
    }
  }, [modelStatus?.downloaded, modelStatus?.loaded, refreshModelStatus]);

  // ── Download model ────────────────────────────────────────────────
  const handleDownload = async () => {
    setLoading(true);
    setError(null);
    try {
      await invoke("download_model");
      await refreshModelStatus();
    } catch (e: any) {
      setError(e.toString());
    } finally {
      setLoading(false);
    }
  };

  // ── Load model ────────────────────────────────────────────────────
  const handleLoad = async () => {
    setLoading(true);
    setError(null);
    try {
      await invoke("load_model");
      await refreshModelStatus();
    } catch (e: any) {
      setError(e.toString());
    } finally {
      setLoading(false);
    }
  };

  // ── Synthesize ────────────────────────────────────────────────────
  const handleSynthesize = async () => {
    if (!text.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const req: SynthesizeRequest = {
        text: text,
        name: trackName.trim() || null,
      };
      await invoke("synthesize", { req });
      setTrackName("");
      await refreshTracks();
    } catch (e: any) {
      setError(e.toString());
    } finally {
      setLoading(false);
    }
  };

  // ── Play track ────────────────────────────────────────────────────
  const handlePlay = async (track: TrackInfo) => {
    if (playingTrack === track.path) {
      setPlayingTrack(null);
      setAudioUrl(null);
      return;
    }

    try {
      const dataUrl = await invoke<string>("get_track_audio", {
        path: track.path,
      });
      setAudioUrl(dataUrl);
      setPlayingTrack(track.path);
    } catch (e: any) {
      setError(e.toString());
    }
  };

  // ── Delete track ──────────────────────────────────────────────────
  const handleDelete = async (track: TrackInfo) => {
    try {
      await invoke("delete_track", { path: track.path });
      if (playingTrack === track.path) {
        setPlayingTrack(null);
        setAudioUrl(null);
      }
      await refreshTracks();
    } catch (e: any) {
      setError(e.toString());
    }
  };

  // ── Audio ended handler ───────────────────────────────────────────
  const handleAudioEnded = () => {
    setPlayingTrack(null);
    setAudioUrl(null);
  };

  // ── Format helpers ────────────────────────────────────────────────
  const formatDuration = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // ── Render ────────────────────────────────────────────────────────
  const isReady = modelStatus?.loaded;

  return (
    <main className="app">
      <header className="app-header">
        <h1>🎙️ Train-Me TTS</h1>
        <p className="subtitle">Text-to-Speech with Tags</p>
      </header>

      {/* ─── Model Status Bar ────────────────────────────────────── */}
      <section className="model-status">
        <div className="status-indicators">
          <span
            className={`status-dot ${modelStatus?.downloaded ? "ok" : "pending"}`}
          />
          <span>
            Model: {modelStatus?.downloaded ? "Downloaded" : "Not downloaded"}
          </span>
          <span
            className={`status-dot ${modelStatus?.loaded ? "ok" : "pending"}`}
            style={{ marginLeft: 16 }}
          />
          <span>Engine: {modelStatus?.loaded ? "Loaded" : "Not loaded"}</span>
        </div>
        <div className="model-actions">
          {!modelStatus?.downloaded && (
            <button
              onClick={handleDownload}
              disabled={loading}
              className="btn btn-secondary"
            >
              {loading ? "Downloading..." : "⬇ Download Model"}
            </button>
          )}
          {modelStatus?.downloaded && !modelStatus?.loaded && (
            <button
              onClick={handleLoad}
              disabled={loading}
              className="btn btn-secondary"
            >
              {loading ? "Loading..." : "📦 Load Model"}
            </button>
          )}
        </div>
      </section>

      {/* ─── Editor ──────────────────────────────────────────────── */}
      <section className="editor">
        <div className="editor-header">
          <h2>TTS Tags Input</h2>
          {isReady && <span className="badge ready">Ready</span>}
        </div>
        <textarea
          className="tts-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Enter TTS tags here..."
          rows={10}
          disabled={!isReady}
        />
        <div className="editor-actions">
          <input
            className="track-name-input"
            value={trackName}
            onChange={(e) => setTrackName(e.target.value)}
            placeholder="Track name (optional)"
            disabled={!isReady}
          />
          <button
            className="btn btn-primary"
            onClick={handleSynthesize}
            disabled={!isReady || loading || !text.trim()}
          >
            {loading ? "⏳ Synthesizing..." : "▶ Synthesize"}
          </button>
        </div>
        {modelStatus?.speakers && modelStatus.speakers.length > 0 && (
          <p className="hint">
            Available speakers: {modelStatus.speakers.join(", ")}
          </p>
        )}
        <details className="tag-help">
          <summary>📖 Tag Reference</summary>
          <pre className="tag-reference">{TAG_REFERENCE}</pre>
        </details>
      </section>

      {/* ─── Error ───────────────────────────────────────────────── */}
      {error && (
        <div className="error-bar">
          <span>⚠️ {error}</span>
          <button className="btn-dismiss" onClick={() => setError(null)}>
            ✕
          </button>
        </div>
      )}

      {/* ─── Tracks ──────────────────────────────────────────────── */}
      <section className="tracks">
        <h2>Tracks ({tracks.length})</h2>
        {tracks.length === 0 ? (
          <p className="empty-state">
            No tracks yet. Synthesize some text above!
          </p>
        ) : (
          <ul className="track-list">
            {tracks.map((track) => (
              <li
                key={track.path}
                className={`track-item ${playingTrack === track.path ? "playing" : ""}`}
              >
                <div className="track-info">
                  <span className="track-name">{track.name}</span>
                  <span className="track-meta">
                    {formatDuration(track.duration)} ·{" "}
                    {formatSize(track.size_bytes)}
                  </span>
                </div>
                <div className="track-actions">
                  <button
                    className="btn btn-icon"
                    onClick={() => handlePlay(track)}
                    title={playingTrack === track.path ? "Stop" : "Play"}
                  >
                    {playingTrack === track.path ? "⏹" : "▶"}
                  </button>
                  <button
                    className="btn btn-icon btn-danger"
                    onClick={() => handleDelete(track)}
                    title="Delete"
                  >
                    🗑
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ─── Audio Player (hidden) ───────────────────────────────── */}
      {audioUrl && (
        <audio
          autoPlay
          src={audioUrl}
          onEnded={handleAudioEnded}
          style={{ display: "none" }}
        />
      )}
    </main>
  );
}

// ============================================================================
// Tag reference text
// ============================================================================

const TAG_REFERENCE = `<voice speaker="male|female" speed="1.0" volume="1.0">
  Spoken content here
</voice>

<pause duration="1.0"/>
<sound type="beep|pop|snap|ding|..." volume="0.5"/>
<tone type="wave" preset="sine|square|whitenoise|..." frequency="440" volume="0.3"/>

<speed value="1.2">Faster content</speed>
<volume value="0.5">Quieter content</volume>

<effect type="echo|reverb|filter" preset="light|heavy">
  Affected content
</effect>

<loop loops="3">Repeated content</loop>

<background volume="0.5">
  <sound type="beep"/>
</background>
Plays concurrently with following content.

<overlay>
  <part>Layer 1</part>
  <part looped="true"><sound type="beep"/></part>
</overlay>

<until button="Press to continue" waiting-sound="heart_beat">
  Repeated until button press
</until>`;

export default App;
