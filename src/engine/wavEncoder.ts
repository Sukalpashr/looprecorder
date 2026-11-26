import type { SavedClipMeta } from '../types/audio';

function writeAscii(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Encodes mono 16-bit signed PCM samples into a standards-compliant WAV Blob.
 */
export function encodeInt16ToWavBlob(samples: Int16Array, sampleRate: number): Blob {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');

  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const outBytes = new Uint8Array(buffer, 44);
  const srcBytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  outBytes.set(srcBytes);

  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Generates an inaudible silent WAV object URL used to anchor the iOS/Safari
 * background audio session & Media Session Lock Screen metadata.
 */
export function createSilentWavBlobUrl(durationSec = 2): string {
  const sampleRate = 8000;
  const length = sampleRate * durationSec;
  const silentPcm = new Int16Array(length);
  // Subtle +/- 1 LSB dither so strict decoders treat the stream as active PCM
  for (let i = 0; i < length; i += 64) {
    silentPcm[i] = i % 128 === 0 ? 1 : -1;
  }
  const blob = encodeInt16ToWavBlob(silentPcm, sampleRate);
  return URL.createObjectURL(blob);
}

/**
 * Downsamples Int16 PCM into normalized peak magnitudes [0..1] for waveform display.
 */
export function computePeaksFromInt16(samples: Int16Array, bucketCount = 120): number[] {
  if (samples.length === 0) return Array(bucketCount).fill(0);
  const peaks: number[] = new Array(bucketCount);
  const step = Math.max(1, samples.length / bucketCount);

  for (let i = 0; i < bucketCount; i++) {
    const start = Math.floor(i * step);
    const end = Math.min(samples.length, Math.floor((i + 1) * step));
    let maxAbs = 0;
    const stride = Math.max(1, Math.floor((end - start) / 64));
    for (let j = start; j < end; j += stride) {
      const v = Math.abs(samples[j]);
      if (v > maxAbs) maxAbs = v;
    }
    peaks[i] = Math.min(1, maxAbs / 32768);
  }
  return peaks;
}

export function sanitizeFilename(title: string): string {
  const base = title
    .trim()
    .replace(/[^a-zA-Z0-9-_\s]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 64);
  return `${base || 'tapeloop-clip'}.wav`;
}

/**
 * Saves a clip to device storage. On iOS/mobile browsers supporting file sharing,
 * opens the native Share Sheet ("Save to Files" / AirDrop); otherwise downloads .wav directly.
 */
export async function exportClipToDevice(
  clip: SavedClipMeta,
  blob: Blob,
  preferShareSheet = true
): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const filename = sanitizeFilename(clip.title);

  if (preferShareSheet && typeof navigator !== 'undefined' && 'share' in navigator) {
    try {
      const file = new File([blob], filename, { type: 'audio/wav' });
      const navWithCanShare = navigator as Navigator & {
        canShare?: (data: ShareData) => boolean;
      };
      if (navWithCanShare.canShare && navWithCanShare.canShare({ files: [file] })) {
        await navigator.share({
          title: clip.title,
          files: [file],
        });
        return 'shared';
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return 'cancelled';
      }
      // Fall through to standard file download
    }
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  setTimeout(() => {
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }, 1500);
  return 'downloaded';
}

export function formatDuration(seconds: number, includeTenths = false): string {
  const clamped = Math.max(0, seconds);
  const hrs = Math.floor(clamped / 3600);
  const mins = Math.floor((clamped % 3600) / 60);
  const secs = Math.floor(clamped % 60);
  const tenths = Math.floor((clamped % 1) * 10);

  const mm = String(mins).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  if (hrs > 0) {
    const hh = String(hrs).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  return includeTenths ? `${mm}:${ss}.${tenths}` : `${mm}:${ss}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatClockTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
