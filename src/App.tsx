import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Mic,
  Pause,
  Play,
  Square,
  Scissors,
  Bookmark,
  Moon,
  Library,
  SlidersHorizontal,
  Radio,
  RotateCcw,
  Check,
  Search,
  Volume2,
  AlertCircle,
  Download,
} from 'lucide-react';
import { CircularAudioEngine } from './engine/CircularAudioEngine';
import {
  computePeaksFromInt16,
  encodeInt16ToWavBlob,
  exportClipToDevice,
  formatBytes,
  formatClockTime,
  formatDuration,
} from './engine/wavEncoder';
import {
  deleteClipFromDB,
  getAllClipMetasFromDB,
  getClipBlobFromDB,
  getDeviceStorageUsage,
  saveClipToDB,
  updateClipMetaInDB,
} from './engine/clipStorage';
import {
  DEFAULT_POWER_SETTINGS,
  SAMPLE_RATE_SPECS,
  type AppTab,
  type EngineTelemetry,
  type PowerSettings,
  type SavedClipMeta,
  type SavedClipRecord,
} from './types/audio';
import { useBackgroundPower } from './hooks/useBackgroundPower';
import {
  CircularWaveformCanvas,
  type TrimSelection,
} from './components/CircularWaveformCanvas';
import { ClipPlayerCard } from './components/ClipPlayerCard';
import { OledStandbyOverlay } from './components/OledStandbyOverlay';
import { PowerSettingsView } from './components/PowerSettingsView';
import { PWAInstallButton } from './components/PWAInstallButton';
import { OfflineIndicator } from './components/OfflineIndicator';

const SETTINGS_STORAGE_KEY = 'tapeloop_power_settings_v1';
const THEME_STORAGE_KEY = 'tapeloop_theme_v1';
const CHECKPOINT_CLIP_ID = 'tapeloop-auto-checkpoint';

function loadInitialSettings(): PowerSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_POWER_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<PowerSettings>;
    return {
      ...DEFAULT_POWER_SETTINGS,
      ...parsed,
      bufferMinutes: Math.max(5, Math.min(30, Number(parsed.bufferMinutes ?? 15))),
    };
  } catch {
    return DEFAULT_POWER_SETTINGS;
  }
}

function loadInitialDark(): boolean {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'light') return false;
    if (saved === 'dark') return true;
  } catch {
    // Ignore storage errors
  }
  return true; // OLED Dark default for 24/7 battery optimization
}

type ZoomWindowOption = '1m' | '5m' | 'full';

interface SaveToast {
  message: string;
  clipId?: string;
}

export default function App() {
  const [settings, setSettings] = useState<PowerSettings>(loadInitialSettings);
  const [isDark, setIsDark] = useState<boolean>(loadInitialDark);
  const [activeTab, setActiveTab] = useState<AppTab>('recorder');
  const [isOledStandby, setIsOledStandby] = useState(false);

  // Audio engine instance (lives for full app lifetime so switching tabs never stops recording)
  const engineRef = useRef<CircularAudioEngine | null>(null);
  if (!engineRef.current) {
    const rate = SAMPLE_RATE_SPECS[settings.sampleRateProfile].sampleRate;
    engineRef.current = new CircularAudioEngine(settings.bufferMinutes, rate);
  }
  const engine = engineRef.current;

  const [telemetry, setTelemetry] = useState<EngineTelemetry>(() => engine.getTelemetry());
  const [zoomOption, setZoomOption] = useState<ZoomWindowOption>('5m');
  const [trimMode, setTrimMode] = useState(false);
  const [trimSelection, setTrimSelection] = useState<TrimSelection>({
    startAgoSec: 60,
    endAgoSec: 0,
  });
  const [isPreviewingTrim, setIsPreviewingTrim] = useState(false);
  const [isSavingClip, setIsSavingClip] = useState(false);

  // Saved Clips Library state
  const [clips, setClips] = useState<SavedClipMeta[]>([]);
  const [playingClipId, setPlayingClipId] = useState<string | null>(null);
  const [librarySearch, setLibrarySearch] = useState('');
  const [libraryFilter, setLibraryFilter] = useState<'all' | 'manual' | 'checkpoints'>('all');
  const [deviceStorage, setDeviceStorage] = useState<{ usedBytes: number; quotaBytes: number | null }>({
    usedBytes: 0,
    quotaBytes: null,
  });
  const [lastCheckpointAt, setLastCheckpointAt] = useState<number | null>(null);
  const [toast, setToast] = useState<SaveToast | null>(null);

  const showToast = useCallback((message: string, clipId?: string) => {
    setToast({ message, clipId });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(id);
  }, [toast]);

  // Sync HTML .dark class and theme-color meta tag
  useEffect(() => {
    const root = document.documentElement;
    if (isDark) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
      metaTheme.setAttribute('content', isDark ? '#0B0C0E' : '#F6F7F9');
    }
    try {
      localStorage.setItem(THEME_STORAGE_KEY, isDark ? 'dark' : 'light');
    } catch {
      // Ignore
    }
  }, [isDark]);

  // Persist PowerSettings & reconfigure engine seamlessly
  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Ignore
    }
    const targetRate = SAMPLE_RATE_SPECS[settings.sampleRateProfile].sampleRate;
    engine.reconfigure(settings.bufferMinutes, targetRate);
    engine.setEventDetection(settings.autoEventMarkers, settings.eventThresholdDb);
    setTelemetry(engine.getTelemetry());
  }, [engine, settings]);

  // Dispose engine on unmount
  useEffect(() => {
    return () => {
      engine.dispose();
    };
  }, [engine]);

  // Load saved clips from IndexedDB on startup
  const refreshLibrary = useCallback(async () => {
    try {
      const [metas, storage] = await Promise.all([
        getAllClipMetasFromDB(),
        getDeviceStorageUsage(),
      ]);
      setClips(metas);
      setDeviceStorage(storage);
    } catch {
      // IndexedDB unavailable in private sandbox
    }
  }, []);

  useEffect(() => {
    void refreshLibrary();
  }, [refreshLibrary]);

  // Poll engine telemetry cleanly (4Hz in normal mode, 1Hz in OLED standby or 15fps eco)
  useEffect(() => {
    const intervalMs = isOledStandby || settings.waveformFps === 0 ? 1000 : settings.waveformFps === 15 ? 400 : 200;
    const id = window.setInterval(() => {
      setTelemetry(engine.getTelemetry());
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [engine, isOledStandby, settings.waveformFps]);

  const updateSettings = useCallback((patch: Partial<PowerSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleToggleLowPower = useCallback((enabled: boolean) => {
    setSettings((prev) => ({
      ...prev,
      lowPowerMode: enabled,
      sampleRateProfile: enabled ? 'voice-16k' : prev.sampleRateProfile,
      waveformFps: enabled ? 15 : 60,
      wakeLockEnabled: enabled ? true : prev.wakeLockEnabled,
      backgroundKeepAlive: enabled ? true : prev.backgroundKeepAlive,
    }));
  }, []);

  const handleStartRecording = useCallback(
    async (overrideSource?: PowerSettings['inputSource']) => {
      const source = overrideSource ?? settings.inputSource;
      if (overrideSource && overrideSource !== settings.inputSource) {
        updateSettings({ inputSource: overrideSource });
      }
      try {
        await engine.start(source);
        setTelemetry(engine.getTelemetry());
      } catch {
        setTelemetry(engine.getTelemetry());
      }
    },
    [engine, settings.inputSource, updateSettings]
  );

  const handleTogglePlayPause = useCallback(async () => {
    if (telemetry.state === 'recording') {
      engine.pause();
      setTelemetry(engine.getTelemetry());
    } else if (telemetry.state === 'paused') {
      await engine.resume();
      setTelemetry(engine.getTelemetry());
    } else {
      await handleStartRecording();
    }
  }, [engine, handleStartRecording, telemetry.state]);

  const handleStopRecording = useCallback(() => {
    engine.stop();
    setIsPreviewingTrim(false);
    setTelemetry(engine.getTelemetry());
  }, [engine]);

  const handleClearBuffer = useCallback(() => {
    engine.stopPreview();
    engine.clearBuffer();
    setIsPreviewingTrim(false);
    setTrimMode(false);
    setTelemetry(engine.getTelemetry());
    showToast('Circular buffer cleared');
  }, [engine, showToast]);

  const saveSegmentFromBuffer = useCallback(
    async (
      startAgoSec: number,
      endAgoSec: number,
      options?: { title?: string; isCheckpoint?: boolean; idOverride?: string }
    ) => {
      if (isSavingClip && !options?.isCheckpoint) return;
      const snap = engine.extractSegment(startAgoSec, endAgoSec);
      if (snap.samples.length === 0 || snap.durationSec < 0.25) {
        if (!options?.isCheckpoint) {
          showToast('Not enough audio in buffer yet');
        }
        return;
      }

      if (!options?.isCheckpoint) setIsSavingClip(true);
      try {
        const blob = encodeInt16ToWavBlob(snap.samples, snap.sampleRate);
        const peaks = computePeaksFromInt16(snap.samples, 120);
        const now = Date.now();
        const defaultTitle = options?.isCheckpoint
          ? `Recovery Checkpoint · ${formatClockTime(snap.endMs)}`
          : `Segment ${formatClockTime(snap.startMs)}`;

        const record: SavedClipRecord = {
          id: options?.idOverride ?? `clip-${now}-${Math.random().toString(36).slice(2, 6)}`,
          title: options?.title ?? defaultTitle,
          createdAt: now,
          capturedStartMs: snap.startMs,
          capturedEndMs: snap.endMs,
          durationSec: snap.durationSec,
          sampleRate: snap.sampleRate,
          sizeBytes: blob.size,
          peaks,
          notes: '',
          isCheckpoint: options?.isCheckpoint,
          audioBlob: blob,
        };

        await saveClipToDB(record);
        await refreshLibrary();

        if (options?.isCheckpoint) {
          setLastCheckpointAt(now);
        } else {
          showToast(
            `Saved ${formatDuration(snap.durationSec)} (${formatBytes(blob.size)} WAV)`,
            record.id
          );
        }
      } catch {
        if (!options?.isCheckpoint) {
          showToast('Unable to write clip to device storage');
        }
      } finally {
        if (!options?.isCheckpoint) setIsSavingClip(false);
      }
    },
    [engine, isSavingClip, refreshLibrary, showToast]
  );

  // Automatic rolling recovery checkpoint protection against iOS termination
  useEffect(() => {
    if (settings.autoCheckpointMinutes <= 0 || telemetry.state !== 'recording') {
      return;
    }
    const intervalMs = settings.autoCheckpointMinutes * 60 * 1000;
    const id = window.setInterval(() => {
      const current = engine.getTelemetry();
      if (current.state === 'recording' && current.bufferedSeconds >= 20) {
        const span = Math.min(current.bufferedSeconds, settings.autoCheckpointMinutes * 60);
        void saveSegmentFromBuffer(span, 0, {
          isCheckpoint: true,
          idOverride: CHECKPOINT_CLIP_ID,
        });
      }
    }, intervalMs);

    return () => window.clearInterval(id);
  }, [
    engine,
    saveSegmentFromBuffer,
    settings.autoCheckpointMinutes,
    telemetry.state,
  ]);

  // Background Wake Lock + Silent Keep-Alive + Lock Screen Media Session
  const powerStatus = useBackgroundPower({
    isRecording: telemetry.state === 'recording',
    wakeLockEnabled: settings.wakeLockEnabled,
    backgroundKeepAlive: settings.backgroundKeepAlive,
    bufferMinutes: settings.bufferMinutes,
    onQuickSaveFromLockScreen: () => {
      void saveSegmentFromBuffer(120, 0, { title: `Lock Screen Capture ${formatClockTime(Date.now())}` });
    },
    onPauseFromLockScreen: () => {
      engine.pause();
      setTelemetry(engine.getTelemetry());
    },
    onResumeFromLockScreen: () => {
      void engine.resume().then(() => setTelemetry(engine.getTelemetry()));
    },
  });

  // Compute active waveform window in seconds based on zoom control
  const windowSeconds = useMemo(() => {
    const cap = settings.bufferMinutes * 60;
    if (zoomOption === '1m') return Math.min(60, cap);
    if (zoomOption === '5m') return Math.min(300, cap);
    return cap;
  }, [settings.bufferMinutes, zoomOption]);

  const handleToggleTrimMode = () => {
    if (trimMode) {
      engine.stopPreview();
      setIsPreviewingTrim(false);
      setTrimMode(false);
      return;
    }
    const available = Math.max(1, Math.min(windowSeconds, telemetry.bufferedSeconds));
    const defaultSpan = Math.min(available, Math.max(5, Math.min(60, available * 0.6)));
    setTrimSelection({ startAgoSec: defaultSpan, endAgoSec: 0 });
    setTrimMode(true);
  };

  const handleTogglePreviewTrim = async () => {
    if (isPreviewingTrim) {
      engine.stopPreview();
      setIsPreviewingTrim(false);
      return;
    }
    setPlayingClipId(null);
    const started = await engine.previewSegment(
      trimSelection.startAgoSec,
      trimSelection.endAgoSec,
      () => setIsPreviewingTrim(false)
    );
    setIsPreviewingTrim(started);
  };

  const handleQuickExportFromToast = async (clipId: string) => {
    const meta = clips.find((c) => c.id === clipId);
    const blob = await getClipBlobFromDB(clipId);
    if (meta && blob) {
      await exportClipToDevice(meta, blob, true);
    }
  };

  const handleUpdateClipMeta = async (id: string, updates: { title: string; notes: string }) => {
    const updated = await updateClipMetaInDB(id, updates);
    if (updated) {
      setClips((prev) => prev.map((c) => (c.id === id ? updated : c)));
    }
  };

  const handleDeleteClip = async (id: string) => {
    if (playingClipId === id) setPlayingClipId(null);
    await deleteClipFromDB(id);
    await refreshLibrary();
  };

  // Filtered library clips
  const filteredClips = useMemo(() => {
    const q = librarySearch.trim().toLowerCase();
    return clips.filter((c) => {
      if (libraryFilter === 'manual' && c.isCheckpoint) return false;
      if (libraryFilter === 'checkpoints' && !c.isCheckpoint) return false;
      if (!q) return true;
      return (
        c.title.toLowerCase().includes(q) ||
        c.notes.toLowerCase().includes(q)
      );
    });
  }, [clips, libraryFilter, librarySearch]);

  const totalClipsBytes = useMemo(
    () => clips.reduce((acc, c) => acc + c.sizeBytes, 0),
    [clips]
  );

  // Normalized live VU meter 0..100%
  const vuPercent = Math.max(0, Math.min(100, ((telemetry.currentDb + 60) / 60) * 100));
  const peakHoldPercent = Math.max(0, Math.min(100, ((telemetry.peakHoldDb + 60) / 60) * 100));
  const bufferFillPercent =
    telemetry.capacitySeconds > 0
      ? Math.min(100, (telemetry.bufferedSeconds / telemetry.capacitySeconds) * 100)
      : 0;

  const isRecording = telemetry.state === 'recording';
  const isPaused = telemetry.state === 'paused';

  return (
    <div className="min-h-screen flex flex-col bg-[#F6F7F9] dark:bg-[#0B0C0E] text-[#111318] dark:text-[#F3F4F6]">
      {/* Top Navigation Bar — strict 3-zone contract on desktop, compact 52px on mobile */}
      <header className="sticky top-0 z-30 h-[52px] lg:h-16 pt-safe bg-white/90 dark:bg-[#0B0C0E]/90 backdrop-blur-md border-b border-neutral-200 dark:border-[#1E222A]">
        <div className="max-w-7xl mx-auto h-full px-4 sm:px-6 lg:px-8 flex items-center justify-between gap-8">
          {/* Zone 1: Single text element wordmark */}
          <button
            type="button"
            onClick={() => setActiveTab('recorder')}
            className="text-lg font-bold tracking-tight text-[#111318] dark:text-[#F3F4F6] whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF3B30] rounded"
          >
            TapeLoop
          </button>

          {/* Zone 2: Clean single-line navigation links (Desktop) */}
          <nav
            aria-label="Primary navigation"
            className="hidden lg:flex items-center gap-8 text-sm font-medium"
          >
            {(
              [
                { id: 'recorder', label: 'Recorder' },
                { id: 'library', label: `Saved Clips (${clips.length})` },
                { id: 'power', label: 'Power & Buffer' },
              ] as { id: AppTab; label: string }[]
            ).map((item) => {
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`relative py-1 whitespace-nowrap shrink-0 transition-colors ${
                    active
                      ? 'text-[#111318] dark:text-white font-semibold'
                      : 'text-neutral-500 dark:text-neutral-400 hover:text-[#111318] dark:hover:text-white'
                  }`}
                >
                  {item.label}
                  {active && (
                    <span className="absolute inset-x-0 -bottom-[19px] h-0.5 bg-[#FF3B30]" />
                  )}
                </button>
              );
            })}
          </nav>

          {/* Zone 3: Single Primary Action */}
          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={() => setIsOledStandby(true)}
              className="inline-flex items-center justify-center gap-1.5 min-h-[38px] px-3.5 py-1.5 rounded-lg bg-[#111318] dark:bg-[#1C1F26] border border-transparent dark:border-[#2C313C] text-xs font-semibold text-white dark:text-[#F3F4F6] hover:opacity-90 active:scale-[0.98] transition whitespace-nowrap shrink-0"
            >
              <Moon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>OLED Standby</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-7 pb-24 lg:pb-10">
        {/* ================= RECORDER VIEW ================= */}
        {activeTab === 'recorder' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Primary Audio Stage (8 columns on desktop) */}
            <div className="lg:col-span-8 space-y-5">
              {/* Error Banner (Microphone denied / unavailable) with 1-tap Test Signal fallback */}
              {telemetry.state === 'error' && telemetry.errorMessage && (
                <div
                  role="alert"
                  className="rounded-2xl border border-red-500/30 bg-red-500/10 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                >
                  <div className="flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 text-[#FF3B30] shrink-0 mt-0.5" aria-hidden="true" />
                    <div className="text-sm text-[#111318] dark:text-neutral-200 leading-relaxed">
                      {telemetry.errorMessage}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleStartRecording('ambient-test')}
                    className="min-h-[40px] px-4 py-2 rounded-xl bg-[#111318] dark:bg-[#F3F4F6] text-white dark:text-[#0B0C0E] text-xs font-semibold whitespace-nowrap shrink-0"
                  >
                    Use Test Signal
                  </button>
                </div>
              )}

              {/* Main Waveform & Metering Deck */}
              <section className="rounded-2xl border border-neutral-200 dark:border-[#272B34] bg-white dark:bg-[#14161A] p-4 sm:p-6 space-y-5">
                {/* Top Readout Header: Timecode + Unboxed Metadata */}
                <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-medium text-neutral-500 dark:text-neutral-400">
                      <span
                        className={
                          isRecording
                            ? 'text-[#FF3B30] font-semibold'
                            : isPaused
                              ? 'text-amber-600 dark:text-amber-400 font-semibold'
                              : ''
                        }
                      >
                        {isRecording
                          ? 'Recording Circular Loop'
                          : isPaused
                            ? 'Loop Paused'
                            : 'Standby'}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {telemetry.activeSource === 'microphone'
                          ? 'Microphone'
                          : 'Test Signal'}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">
                        {SAMPLE_RATE_SPECS[settings.sampleRateProfile].shortLabel}
                      </span>
                    </div>

                    <div className="mt-1 flex items-baseline gap-2.5">
                      <span className="font-mono text-4xl sm:text-5xl font-semibold tracking-tight tabular-nums text-[#111318] dark:text-white">
                        {formatDuration(telemetry.bufferedSeconds)}
                      </span>
                      <span className="font-mono text-lg sm:text-xl tabular-nums text-neutral-400 dark:text-neutral-500">
                        / {formatDuration(telemetry.capacitySeconds)}
                      </span>
                    </div>
                  </div>

                  {/* Live Input Level (VU Meter + dB) */}
                  <div className="w-full sm:w-52 space-y-1.5">
                    <div className="flex items-center justify-between text-xs font-mono tabular-nums">
                      <span className="text-neutral-500 dark:text-neutral-400">Input Level</span>
                      <span className="text-[#111318] dark:text-neutral-200 font-medium">
                        {isRecording ? `${telemetry.currentDb.toFixed(1)} dB` : '--.- dB'}
                      </span>
                    </div>
                    <div className="relative h-2 w-full rounded-full bg-neutral-100 dark:bg-[#0B0C0E] overflow-hidden border border-neutral-200/80 dark:border-[#272B34]">
                      <div
                        className={`h-full transition-[width] duration-75 ${
                          telemetry.currentDb > -6
                            ? 'bg-[#FF3B30]'
                            : telemetry.currentDb > -18
                              ? 'bg-amber-500'
                              : 'bg-[#111318] dark:bg-neutral-200'
                        }`}
                        style={{ width: `${isRecording ? vuPercent : 0}%` }}
                      />
                      {isRecording && peakHoldPercent > 4 && (
                        <div
                          className="absolute top-0 bottom-0 w-0.5 bg-[#FF3B30]"
                          style={{ left: `${peakHoldPercent}%` }}
                        />
                      )}
                    </div>
                    <div className="flex items-center justify-between text-[11px] font-mono tabular-nums text-neutral-400 dark:text-neutral-500">
                      <span>Session {formatDuration(telemetry.totalSessionSeconds)}</span>
                      <span>{Math.round(bufferFillPercent)}% full</span>
                    </div>
                  </div>
                </div>

                {/* Timeline Controls Row: Buffer Length Quick-Select + Zoom + Bookmark */}
                <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                  {/* Timeline Zoom Segmented Control */}
                  <div
                    className="inline-flex items-center p-1 rounded-xl bg-neutral-100 dark:bg-[#0B0C0E]"
                    role="group"
                    aria-label="Waveform timeline zoom"
                  >
                    {(
                      [
                        { id: '1m', label: '1m View' },
                        { id: '5m', label: '5m View' },
                        { id: 'full', label: `Full ${settings.bufferMinutes}m` },
                      ] as { id: ZoomWindowOption; label: string }[]
                    ).map((z) => (
                      <button
                        key={z.id}
                        type="button"
                        onClick={() => setZoomOption(z.id)}
                        className={`min-h-[36px] px-3 py-1.5 rounded-lg text-xs font-semibold transition whitespace-nowrap ${
                          zoomOption === z.id
                            ? 'bg-white dark:bg-[#1C1F26] text-[#111318] dark:text-white shadow-sm'
                            : 'text-neutral-500 dark:text-neutral-400 hover:text-[#111318] dark:hover:text-white'
                        }`}
                      >
                        {z.label}
                      </button>
                    ))}
                  </div>

                  {/* Quick Buffer Window Size & Manual Marker */}
                  <div className="flex items-center gap-2">
                    <select
                      value={settings.bufferMinutes}
                      onChange={(e) => updateSettings({ bufferMinutes: Number(e.target.value) })}
                      aria-label="Circular buffer length"
                      className="min-h-[40px] rounded-xl border border-neutral-200 dark:border-[#272B34] bg-neutral-50 dark:bg-[#0B0C0E] px-3 py-1.5 font-mono text-xs font-semibold text-[#111318] dark:text-[#F3F4F6] focus:outline-none focus:ring-2 focus:ring-[#FF3B30]"
                    >
                      {[5, 10, 15, 20, 30].map((m) => (
                        <option key={m} value={m}>
                          Buffer: {m} min
                        </option>
                      ))}
                    </select>

                    <button
                      type="button"
                      onClick={() => {
                        engine.addManualMarker('Bookmark');
                        showToast('Bookmark dropped on timeline');
                      }}
                      disabled={!isRecording}
                      className="inline-flex items-center gap-1.5 min-h-[40px] px-3 py-1.5 rounded-xl border border-neutral-200 dark:border-[#272B34] bg-neutral-50 dark:bg-[#0B0C0E] text-xs font-semibold text-[#111318] dark:text-[#F3F4F6] hover:bg-neutral-100 dark:hover:bg-[#1C1F26] disabled:opacity-40 transition whitespace-nowrap"
                    >
                      <Bookmark className="w-3.5 h-3.5 text-[#FF3B30]" aria-hidden="true" />
                      <span>Mark</span>
                    </button>
                  </div>
                </div>

                {/* Live Rolling Waveform Canvas */}
                <CircularWaveformCanvas
                  engine={engine}
                  isRecording={isRecording}
                  isDark={isDark}
                  waveformFps={settings.waveformFps}
                  isSuspended={isOledStandby}
                  windowSeconds={windowSeconds}
                  bufferedSeconds={telemetry.bufferedSeconds}
                  capacitySeconds={telemetry.capacitySeconds}
                  trimMode={trimMode}
                  trimSelection={trimSelection}
                  onTrimChange={setTrimSelection}
                  onEnterTrimMode={() => setTrimMode(true)}
                />

                {/* Active Trim Controls Bar */}
                {trimMode && (
                  <div className="rounded-xl bg-neutral-50 dark:bg-[#0B0C0E] border border-neutral-200 dark:border-[#272B34] p-3.5 flex flex-wrap items-center justify-between gap-3">
                    <div className="space-y-0.5">
                      <div className="text-xs font-semibold text-[#111318] dark:text-white">
                        Custom Segment Selection
                      </div>
                      <div className="font-mono text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
                        Duration{' '}
                        {formatDuration(
                          Math.max(0, trimSelection.startAgoSec - trimSelection.endAgoSec)
                        )}{' '}
                        · -{formatDuration(trimSelection.startAgoSec)} to -
                        {formatDuration(trimSelection.endAgoSec)}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleTogglePreviewTrim()}
                        disabled={telemetry.bufferedSeconds < 1}
                        className="inline-flex items-center gap-1.5 min-h-[40px] px-3.5 py-2 rounded-xl border border-neutral-200 dark:border-[#272B34] bg-white dark:bg-[#14161A] text-xs font-semibold text-[#111318] dark:text-white hover:bg-neutral-100 dark:hover:bg-[#1C1F26] transition whitespace-nowrap"
                      >
                        {isPreviewingTrim ? (
                          <>
                            <Square className="w-3.5 h-3.5 fill-current text-[#FF3B30]" aria-hidden="true" />
                            <span>Stop Preview</span>
                          </>
                        ) : (
                          <>
                            <Volume2 className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>Preview</span>
                          </>
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          void saveSegmentFromBuffer(
                            trimSelection.startAgoSec,
                            trimSelection.endAgoSec
                          );
                          setTrimMode(false);
                        }}
                        disabled={isSavingClip || telemetry.bufferedSeconds < 1}
                        className="inline-flex items-center gap-1.5 min-h-[40px] px-4 py-2 rounded-xl bg-[#FF3B30] text-white text-xs font-semibold hover:bg-[#E6352B] active:scale-[0.98] transition whitespace-nowrap"
                      >
                        <Check className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Save Segment</span>
                      </button>

                      <button
                        type="button"
                        onClick={handleToggleTrimMode}
                        className="min-h-[40px] px-3 py-2 rounded-xl text-xs font-medium text-neutral-500 hover:text-[#111318] dark:hover:text-white transition"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {/* Primary Thumb-Zone Quick-Save Bar (Easy retroactive segment capture) */}
                <div className="space-y-2.5 pt-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-neutral-600 dark:text-neutral-300">
                      Instant Retroactive Save
                    </span>
                    <span className="text-xs text-neutral-400 dark:text-neutral-500">
                      Saves without stopping live loop
                    </span>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                    {(
                      [
                        { sec: 30, label: 'Save Last 30s' },
                        { sec: 120, label: 'Save Last 2m' },
                        { sec: 300, label: 'Save Last 5m' },
                      ] as const
                    ).map((preset) => (
                      <button
                        key={preset.sec}
                        type="button"
                        disabled={isSavingClip || telemetry.bufferedSeconds < 1}
                        onClick={() => void saveSegmentFromBuffer(preset.sec, 0)}
                        className="min-h-[48px] px-3 py-2.5 rounded-xl border border-neutral-200 dark:border-[#272B34] bg-neutral-50 dark:bg-[#1C1F26] text-xs font-semibold text-[#111318] dark:text-[#F3F4F6] hover:border-neutral-300 dark:hover:border-[#3A404D] active:scale-[0.98] disabled:opacity-40 transition whitespace-nowrap"
                      >
                        {preset.label}
                      </button>
                    ))}

                    <button
                      type="button"
                      disabled={telemetry.bufferedSeconds < 1}
                      onClick={handleToggleTrimMode}
                      className={`min-h-[48px] px-3 py-2.5 rounded-xl border text-xs font-semibold inline-flex items-center justify-center gap-1.5 active:scale-[0.98] disabled:opacity-40 transition whitespace-nowrap ${
                        trimMode
                          ? 'border-[#FF3B30] bg-[#FF3B30]/10 text-[#FF3B30]'
                          : 'border-neutral-200 dark:border-[#272B34] bg-neutral-50 dark:bg-[#1C1F26] text-[#111318] dark:text-[#F3F4F6] hover:border-neutral-300 dark:hover:border-[#3A404D]'
                      }`}
                    >
                      <Scissors className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                      <span>{trimMode ? 'Exit Trim' : 'Custom Trim'}</span>
                    </button>
                  </div>
                </div>
              </section>

              {/* Tactile Transport Control Bar */}
              <section className="rounded-2xl border border-neutral-200 dark:border-[#272B34] bg-white dark:bg-[#14161A] p-4 sm:p-5 flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3 flex-1 min-w-[220px]">
                  <button
                    type="button"
                    onClick={() => void handleTogglePlayPause()}
                    className={`min-h-[52px] flex-1 sm:flex-none sm:min-w-[200px] px-6 py-3 rounded-2xl text-sm font-semibold inline-flex items-center justify-center gap-2.5 active:scale-[0.98] transition whitespace-nowrap ${
                      isRecording
                        ? 'bg-[#111318] dark:bg-[#F3F4F6] text-white dark:text-[#0B0C0E]'
                        : 'bg-[#FF3B30] text-white hover:bg-[#E6352B] shadow-md shadow-[#FF3B30]/20'
                    }`}
                  >
                    {isRecording ? (
                      <>
                        <Pause className="w-4 h-4 fill-current" aria-hidden="true" />
                        <span>Pause Loop</span>
                      </>
                    ) : isPaused ? (
                      <>
                        <Play className="w-4 h-4 fill-current" aria-hidden="true" />
                        <span>Resume Loop</span>
                      </>
                    ) : (
                      <>
                        <Mic className="w-4 h-4" aria-hidden="true" />
                        <span>Start 24/7 Loop</span>
                      </>
                    )}
                  </button>

                  {(isRecording || isPaused) && (
                    <button
                      type="button"
                      onClick={handleStopRecording}
                      aria-label="Stop recording loop"
                      className="min-h-[52px] min-w-[52px] px-4 rounded-2xl border border-neutral-200 dark:border-[#272B34] bg-neutral-50 dark:bg-[#1C1F26] text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-[#272B34] flex items-center justify-center gap-2 text-xs font-semibold transition"
                    >
                      <Square className="w-4 h-4 fill-current" aria-hidden="true" />
                      <span className="hidden sm:inline">Stop</span>
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {telemetry.bufferedSeconds >= 1 && (
                    <button
                      type="button"
                      onClick={() => void saveSegmentFromBuffer(telemetry.bufferedSeconds, 0)}
                      disabled={isSavingClip}
                      className="min-h-[44px] px-3.5 py-2 rounded-xl border border-neutral-200 dark:border-[#272B34] text-xs font-semibold text-[#111318] dark:text-[#F3F4F6] hover:bg-neutral-100 dark:hover:bg-[#1C1F26] transition whitespace-nowrap"
                    >
                      Save Full Buffer
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleClearBuffer}
                    disabled={telemetry.bufferedSeconds < 0.5}
                    aria-label="Clear circular buffer"
                    className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-neutral-500 hover:text-[#111318] dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-[#1C1F26] disabled:opacity-35 transition"
                  >
                    <RotateCcw className="w-4 h-4" />
                  </button>
                </div>
              </section>
            </div>

            {/* Right Rail (4 columns on desktop): Power Continuity + Quick Clips */}
            <aside className="lg:col-span-4 space-y-5">
              {/* Background Continuity & Battery Summary */}
              <section className="rounded-2xl border border-neutral-200 dark:border-[#272B34] bg-white dark:bg-[#14161A] p-5 space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold text-[#111318] dark:text-[#F3F4F6]">
                    24/7 Power Profile
                  </h2>
                  <button
                    type="button"
                    onClick={() => handleToggleLowPower(!settings.lowPowerMode)}
                    className={`min-h-[34px] px-3 py-1 rounded-lg text-xs font-semibold transition whitespace-nowrap ${
                      settings.lowPowerMode
                        ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                        : 'bg-neutral-100 dark:bg-[#1C1F26] text-neutral-600 dark:text-neutral-300'
                    }`}
                  >
                    {settings.lowPowerMode ? 'Low-Power On' : 'Enable Low-Power'}
                  </button>
                </div>

                <dl className="divide-y divide-neutral-100 dark:divide-[#1E222A] text-xs">
                  <div className="py-2.5 flex items-center justify-between">
                    <dt className="text-neutral-500 dark:text-neutral-400">Ring Buffer RAM</dt>
                    <dd className="font-mono font-semibold tabular-nums text-[#111318] dark:text-[#F3F4F6]">
                      {formatBytes(telemetry.memoryBytes)}
                    </dd>
                  </div>
                  <div className="py-2.5 flex items-center justify-between">
                    <dt className="text-neutral-500 dark:text-neutral-400">Screen Wake Lock</dt>
                    <dd className="font-medium text-[#111318] dark:text-[#F3F4F6]">
                      {powerStatus.wakeLockActive
                        ? 'Engaged'
                        : settings.wakeLockEnabled
                          ? 'Armed'
                          : 'Off'}
                    </dd>
                  </div>
                  <div className="py-2.5 flex items-center justify-between">
                    <dt className="text-neutral-500 dark:text-neutral-400">Background Anchor</dt>
                    <dd className="font-medium text-[#111318] dark:text-[#F3F4F6]">
                      {powerStatus.keepAliveActive
                        ? 'Active'
                        : settings.backgroundKeepAlive
                          ? 'Armed'
                          : 'Off'}
                    </dd>
                  </div>
                  <div className="py-2.5 flex items-center justify-between">
                    <dt className="text-neutral-500 dark:text-neutral-400">Waveform FPS</dt>
                    <dd className="font-mono tabular-nums text-[#111318] dark:text-[#F3F4F6]">
                      {settings.waveformFps === 0 ? 'Paused' : `${settings.waveformFps} fps`}
                    </dd>
                  </div>
                  <div className="py-2.5 flex items-center justify-between">
                    <dt className="text-neutral-500 dark:text-neutral-400">Auto-Checkpoint</dt>
                    <dd className="font-mono tabular-nums text-[#111318] dark:text-[#F3F4F6]">
                      {settings.autoCheckpointMinutes > 0
                        ? `Every ${settings.autoCheckpointMinutes}m`
                        : 'Off'}
                    </dd>
                  </div>
                </dl>

                <div className="pt-1 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => setActiveTab('power')}
                    className="text-xs font-semibold text-[#111318] dark:text-[#F3F4F6] hover:underline"
                  >
                    Configure Power & Buffer
                  </button>
                  <PWAInstallButton variant="compact" />
                </div>
              </section>

              {/* Recent Saved Clips Quick Access */}
              <section className="rounded-2xl border border-neutral-200 dark:border-[#272B34] bg-white dark:bg-[#14161A] p-5 space-y-3.5">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-[#111318] dark:text-[#F3F4F6]">
                    Recent Segments
                  </h2>
                  {clips.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setActiveTab('library')}
                      className="text-xs font-semibold text-neutral-500 hover:text-[#111318] dark:hover:text-white"
                    >
                      All {clips.length}
                    </button>
                  )}
                </div>

                {clips.length === 0 ? (
                  <p className="text-xs text-neutral-500 dark:text-neutral-400 leading-relaxed py-2">
                    Saved clips appear here and persist offline in local device storage for instant WAV export.
                  </p>
                ) : (
                  <ul className="divide-y divide-neutral-100 dark:divide-[#1E222A]">
                    {clips.slice(0, 4).map((clip) => (
                      <li key={clip.id} className="py-2.5 first:pt-0 last:pb-0">
                        <button
                          type="button"
                          onClick={() => setActiveTab('library')}
                          className="w-full text-left flex items-center justify-between gap-3 group"
                        >
                          <div className="min-w-0">
                            <div className="text-xs font-semibold text-[#111318] dark:text-[#F3F4F6] truncate group-hover:text-[#FF3B30] transition-colors">
                              {clip.title}
                            </div>
                            <div className="mt-0.5 font-mono text-[11px] tabular-nums text-neutral-500 dark:text-neutral-400">
                              {formatDuration(clip.durationSec)} · {formatBytes(clip.sizeBytes)}
                            </div>
                          </div>
                          <span className="text-xs font-medium text-neutral-400 group-hover:text-[#111318] dark:group-hover:text-white shrink-0">
                            Open
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </aside>
          </div>
        )}

        {/* ================= SAVED CLIPS LIBRARY VIEW ================= */}
        {activeTab === 'library' && (
          <div className="space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
              <div>
                <h1 className="text-2xl font-bold tracking-tight text-[#111318] dark:text-white">
                  Saved Audio Segments
                </h1>
                <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400 font-mono tabular-nums">
                  {clips.length} {clips.length === 1 ? 'clip' : 'clips'} ·{' '}
                  {formatBytes(totalClipsBytes)} stored on device
                  {deviceStorage.quotaBytes
                    ? ` (${formatBytes(deviceStorage.quotaBytes)} available quota)`
                    : ''}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                <div className="relative flex-1 sm:flex-none sm:w-60">
                  <Search
                    className="w-4 h-4 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                    aria-hidden="true"
                  />
                  <input
                    type="search"
                    value={librarySearch}
                    onChange={(e) => setLibrarySearch(e.target.value)}
                    placeholder="Search clips or notes..."
                    aria-label="Search saved clips"
                    className="w-full min-h-[42px] pl-9 pr-3 py-2 rounded-xl border border-neutral-200 dark:border-[#272B34] bg-white dark:bg-[#14161A] text-sm text-[#111318] dark:text-white placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-[#FF3B30]"
                  />
                </div>

                <div className="inline-flex items-center p-1 rounded-xl bg-neutral-200/70 dark:bg-[#14161A] border border-neutral-200 dark:border-[#272B34]">
                  {(
                    [
                      { id: 'all', label: 'All' },
                      { id: 'manual', label: 'Saved' },
                      { id: 'checkpoints', label: 'Recovery' },
                    ] as const
                  ).map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setLibraryFilter(f.id)}
                      className={`min-h-[34px] px-3 py-1 rounded-lg text-xs font-semibold transition whitespace-nowrap ${
                        libraryFilter === f.id
                          ? 'bg-white dark:bg-[#272B34] text-[#111318] dark:text-white shadow-sm'
                          : 'text-neutral-500 dark:text-neutral-400'
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {filteredClips.length === 0 ? (
              <div className="rounded-2xl border border-neutral-200 dark:border-[#272B34] bg-white dark:bg-[#14161A] p-10 text-center space-y-3">
                <p className="text-base font-semibold text-[#111318] dark:text-white">
                  {clips.length === 0 ? 'No saved audio segments yet' : 'No clips match your search'}
                </p>
                <p className="text-sm text-neutral-500 dark:text-neutral-400 max-w-md mx-auto">
                  {clips.length === 0
                    ? 'Start the circular loop on the Recorder tab, then tap Save Last 30s, 2m, 5m, or drag on the waveform to extract any segment.'
                    : 'Try clearing your search term or switching the filter back to All.'}
                </p>
                {clips.length === 0 && (
                  <button
                    type="button"
                    onClick={() => setActiveTab('recorder')}
                    className="mt-2 inline-flex items-center justify-center min-h-[44px] px-5 py-2.5 rounded-xl bg-[#FF3B30] text-white text-sm font-semibold hover:bg-[#E6352B] transition"
                  >
                    Open Recorder
                  </button>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {filteredClips.map((clip) => (
                  <ClipPlayerCard
                    key={clip.id}
                    clip={clip}
                    isDark={isDark}
                    isPlaying={playingClipId === clip.id}
                    onRequestPlay={setPlayingClipId}
                    onUpdateMeta={handleUpdateClipMeta}
                    onDelete={handleDeleteClip}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* ================= POWER & BUFFER SETTINGS VIEW ================= */}
        {activeTab === 'power' && (
          <div className="space-y-5">
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-[#111318] dark:text-white">
                Power, Memory & Continuity
              </h1>
              <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                Tune ring buffer capacity (5–30 min), PCM sample rate, and iOS battery safeguards for prolonged 24/7 operation.
              </p>
            </div>

            <PowerSettingsView
              settings={settings}
              onChange={updateSettings}
              onToggleLowPower={handleToggleLowPower}
              powerStatus={powerStatus}
              isDark={isDark}
              onToggleTheme={() => setIsDark((d) => !d)}
              onEnterOledStandby={() => setIsOledStandby(true)}
              lastCheckpointAt={lastCheckpointAt}
            />
          </div>
        )}
      </main>

      {/* Mobile Fixed Bottom Tab Bar (56px + safe area, strictly <= 15% aggregate sticky height) */}
      <nav
        aria-label="Mobile navigation"
        className="lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/95 dark:bg-[#0B0C0E]/95 backdrop-blur-md border-t border-neutral-200 dark:border-[#1E222A] pb-safe"
      >
        <div className="grid grid-cols-3 h-[56px]">
          {(
            [
              { id: 'recorder', label: 'Recorder', icon: Radio },
              { id: 'library', label: clips.length > 0 ? `Clips (${clips.length})` : 'Clips', icon: Library },
              { id: 'power', label: 'Power', icon: SlidersHorizontal },
            ] as { id: AppTab; label: string; icon: typeof Radio }[]
          ).map(({ id, label, icon: Icon }) => {
            const active = activeTab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                className={`min-h-[44px] flex flex-col items-center justify-center gap-0.5 transition-colors ${
                  active
                    ? 'text-[#FF3B30]'
                    : 'text-neutral-500 dark:text-neutral-400'
                }`}
              >
                <Icon className="w-5 h-5" aria-hidden="true" />
                <span className="text-[11px] font-semibold tracking-tight whitespace-nowrap">
                  {label}
                </span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* Non-blocking Save Toast with 1-tap Export to Device */}
      {toast && (
        <div
          role="status"
          className="fixed bottom-20 lg:bottom-6 right-4 left-4 sm:left-auto sm:max-w-sm z-50 rounded-xl bg-[#111318] dark:bg-[#F3F4F6] text-white dark:text-[#0B0C0E] px-4 py-3 shadow-xl flex items-center justify-between gap-3"
        >
          <span className="text-xs font-semibold">{toast.message}</span>
          {toast.clipId && (
            <button
              type="button"
              onClick={() => void handleQuickExportFromToast(toast.clipId!)}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#FF3B30] text-white text-xs font-semibold shrink-0 whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Export</span>
            </button>
          )}
        </div>
      )}

      {/* OLED Pure Black Pocket Standby Overlay */}
      <OledStandbyOverlay
        isOpen={isOledStandby}
        isRecording={isRecording}
        bufferedSeconds={telemetry.bufferedSeconds}
        capacitySeconds={telemetry.capacitySeconds}
        wakeLockActive={powerStatus.wakeLockActive}
        onQuickSave2m={() => saveSegmentFromBuffer(120, 0)}
        onExit={() => setIsOledStandby(false)}
      />

      {/* PWA Offline Awareness */}
      <OfflineIndicator />
    </div>
  );
}
