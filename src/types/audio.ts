export type SampleRateProfile = 'voice-16k' | 'balanced-22k' | 'studio-44k';

export type InputSourceMode = 'microphone' | 'ambient-test';

export type WaveformFpsMode = 60 | 15 | 0;

export type AppTab = 'recorder' | 'library' | 'power';

export interface SampleRateSpec {
  id: SampleRateProfile;
  label: string;
  shortLabel: string;
  sampleRate: number;
  description: string;
  bytesPerSecond: number;
}

export const SAMPLE_RATE_SPECS: Record<SampleRateProfile, SampleRateSpec> = {
  'voice-16k': {
    id: 'voice-16k',
    label: 'Voice 24/7 (16 kHz)',
    shortLabel: '16 kHz',
    sampleRate: 16000,
    description: 'Lowest memory footprint (~58 MB / 30 min). Ideal for continuous all-day iOS capture.',
    bytesPerSecond: 32000,
  },
  'balanced-22k': {
    id: 'balanced-22k',
    label: 'Balanced (22.05 kHz)',
    shortLabel: '22 kHz',
    sampleRate: 22050,
    description: 'Clear voice & room acoustics (~79 MB / 30 min) with moderate power draw.',
    bytesPerSecond: 44100,
  },
  'studio-44k': {
    id: 'studio-44k',
    label: 'Studio Ambient (44.1 kHz)',
    shortLabel: '44.1 kHz',
    sampleRate: 44100,
    description: 'Full CD-rate detail (~159 MB / 30 min). Best for music and field recording.',
    bytesPerSecond: 88200,
  },
};

export interface PowerSettings {
  bufferMinutes: number; // 5 to 30
  sampleRateProfile: SampleRateProfile;
  waveformFps: WaveformFpsMode;
  wakeLockEnabled: boolean;
  backgroundKeepAlive: boolean;
  autoEventMarkers: boolean;
  eventThresholdDb: number; // e.g. -24 dB
  autoCheckpointMinutes: number; // 0 (off), 5, 10, 15
  lowPowerMode: boolean;
  inputSource: InputSourceMode;
}

export const DEFAULT_POWER_SETTINGS: PowerSettings = {
  bufferMinutes: 15,
  sampleRateProfile: 'voice-16k',
  waveformFps: 60,
  wakeLockEnabled: true,
  backgroundKeepAlive: true,
  autoEventMarkers: true,
  eventThresholdDb: -22,
  autoCheckpointMinutes: 5,
  lowPowerMode: false,
  inputSource: 'microphone',
};

export interface TimelineMarker {
  id: string;
  timestampMs: number;
  label: string;
  kind: 'manual' | 'peak';
  peakDb?: number;
}

export interface SavedClipMeta {
  id: string;
  title: string;
  createdAt: number;
  capturedStartMs: number;
  capturedEndMs: number;
  durationSec: number;
  sampleRate: number;
  sizeBytes: number;
  peaks: number[];
  notes: string;
  isCheckpoint?: boolean;
}

export interface SavedClipRecord extends SavedClipMeta {
  audioBlob: Blob;
}

export interface EngineTelemetry {
  state: 'idle' | 'recording' | 'paused' | 'error';
  errorMessage: string | null;
  bufferedSeconds: number;
  capacitySeconds: number;
  totalSessionSeconds: number;
  currentDb: number;
  peakHoldDb: number;
  sampleRate: number;
  memoryBytes: number;
  activeSource: InputSourceMode;
  lastWriteMs: number;
}
