import type { EngineTelemetry, InputSourceMode, TimelineMarker } from '../types/audio';

const PEAKS_PER_SECOND = 10;

// Inline AudioWorklet processor source to avoid external worker path issues in PWA/offline builds
const WORKLET_CODE = `
class TapeLoopCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0 && input[0] && input[0].length > 0) {
      // Copy frame and transfer to main thread ring buffer
      const channel = new Float32Array(input[0]);
      this.port.postMessage(channel, [channel.buffer]);
    }
    return true;
  }
}
registerProcessor('tapeloop-capture-processor', TapeLoopCaptureProcessor);
`;

export interface TimelineSnapshot {
  peaks: Float32Array;
  bufferedSeconds: number;
  capacitySeconds: number;
  windowSeconds: number;
  nowMs: number;
  currentDb: number;
  peakHoldDb: number;
  markers: TimelineMarker[];
}

export class CircularAudioEngine {
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: AudioNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private muteGain: GainNode | null = null;
  private testOscTimer: number | null = null;
  private previewSource: AudioBufferSourceNode | null = null;

  // Ring buffer storage (Int16 PCM for low RAM footprint on iOS)
  private bufferMinutes: number;
  private targetSampleRate: number;
  private pcmRing: Int16Array;
  private writeIndex = 0;
  private totalWrittenSamples = 0;
  private sessionSamples = 0;

  // Resampling state from hardware AudioContext sampleRate -> targetSampleRate
  private resampleFrac = 0;
  private prevSample = 0;

  // Synchronized peak ring buffer (10 peaks/second) for zero-allocation 60fps/15fps waveform drawing
  private peakRing: Float32Array;
  private peakWriteIndex = 0;
  private totalWrittenPeaks = 0;
  private peakSampleAccum = 0;
  private currentBucketMax = 0;
  private samplesPerPeak: number;

  // Live metering & auto-event detection
  private state: EngineTelemetry['state'] = 'idle';
  private errorMessage: string | null = null;
  private activeSource: InputSourceMode = 'microphone';
  private currentDb = -60;
  private peakHoldDb = -60;
  private peakHoldDecayTs = 0;
  private lastWriteMs = Date.now();

  private autoEventMarkers = true;
  private eventThresholdDb = -22;
  private lastPeakMarkerMs = 0;
  private markers: TimelineMarker[] = [];

  constructor(bufferMinutes = 15, targetSampleRate = 16000) {
    this.bufferMinutes = bufferMinutes;
    this.targetSampleRate = targetSampleRate;
    const totalSamples = Math.floor(bufferMinutes * 60 * targetSampleRate);
    this.pcmRing = new Int16Array(totalSamples);
    this.samplesPerPeak = Math.max(1, Math.floor(targetSampleRate / PEAKS_PER_SECOND));
    this.peakRing = new Float32Array(Math.floor(bufferMinutes * 60 * PEAKS_PER_SECOND));
  }

  public setEventDetection(enabled: boolean, thresholdDb: number): void {
    this.autoEventMarkers = enabled;
    this.eventThresholdDb = thresholdDb;
  }

  public getTelemetry(): EngineTelemetry {
    const capacitySeconds = this.pcmRing.length / this.targetSampleRate;
    const bufferedSeconds = Math.min(capacitySeconds, this.totalWrittenSamples / this.targetSampleRate);
    return {
      state: this.state,
      errorMessage: this.errorMessage,
      bufferedSeconds,
      capacitySeconds,
      totalSessionSeconds: this.sessionSamples / this.targetSampleRate,
      currentDb: this.currentDb,
      peakHoldDb: this.peakHoldDb,
      sampleRate: this.targetSampleRate,
      memoryBytes: this.pcmRing.byteLength + this.peakRing.byteLength,
      activeSource: this.activeSource,
      lastWriteMs: this.lastWriteMs,
    };
  }

  /**
   * Reconfigures buffer window (5-30 min) or target sample rate while preserving the
   * most recent captured audio tail when sample rate is unchanged.
   */
  public reconfigure(newBufferMinutes: number, newTargetSampleRate: number): void {
    const clampedMinutes = Math.max(5, Math.min(30, Math.round(newBufferMinutes)));
    if (clampedMinutes === this.bufferMinutes && newTargetSampleRate === this.targetSampleRate) {
      return;
    }

    const oldSampleRate = this.targetSampleRate;
    const oldSamplesCount = Math.min(this.totalWrittenSamples, this.pcmRing.length);
    let preservedTail: Int16Array | null = null;

    if (oldSamplesCount > 0 && oldSampleRate === newTargetSampleRate) {
      const keepCapacity = Math.floor(clampedMinutes * 60 * newTargetSampleRate);
      const keepCount = Math.min(oldSamplesCount, keepCapacity);
      preservedTail = this.readLastSamples(keepCount);
    }

    this.bufferMinutes = clampedMinutes;
    this.targetSampleRate = newTargetSampleRate;
    const newTotalSamples = Math.floor(clampedMinutes * 60 * newTargetSampleRate);
    this.pcmRing = new Int16Array(newTotalSamples);
    this.samplesPerPeak = Math.max(1, Math.floor(newTargetSampleRate / PEAKS_PER_SECOND));
    this.peakRing = new Float32Array(Math.floor(clampedMinutes * 60 * PEAKS_PER_SECOND));

    this.writeIndex = 0;
    this.totalWrittenSamples = 0;
    this.peakWriteIndex = 0;
    this.totalWrittenPeaks = 0;
    this.peakSampleAccum = 0;
    this.currentBucketMax = 0;

    if (preservedTail && preservedTail.length > 0) {
      this.pcmRing.set(preservedTail, 0);
      this.writeIndex = preservedTail.length % this.pcmRing.length;
      this.totalWrittenSamples = preservedTail.length;

      // Rebuild peak ring from preserved PCM tail
      const numPeaks = Math.floor(preservedTail.length / this.samplesPerPeak);
      for (let p = 0; p < numPeaks; p++) {
        const start = p * this.samplesPerPeak;
        const end = Math.min(preservedTail.length, start + this.samplesPerPeak);
        let maxAbs = 0;
        for (let i = start; i < end; i += 8) {
          const v = Math.abs(preservedTail[i]);
          if (v > maxAbs) maxAbs = v;
        }
        this.peakRing[this.peakWriteIndex] = Math.min(1, maxAbs / 32768);
        this.peakWriteIndex = (this.peakWriteIndex + 1) % this.peakRing.length;
        this.totalWrittenPeaks++;
      }
    }

    this.pruneExpiredMarkers();
  }

  public async start(sourceMode: InputSourceMode = 'microphone'): Promise<void> {
    if (this.state === 'recording' && this.activeSource === sourceMode) {
      return;
    }
    this.stopInternalNodes();
    this.errorMessage = null;
    this.activeSource = sourceMode;

    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!this.audioContext || this.audioContext.state === 'closed') {
        this.audioContext = new AudioCtx({ latencyHint: 'playback' });
      }
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      if (sourceMode === 'microphone') {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('Microphone API is unavailable in this browser context. Switch to Test Signal in Power settings to test.');
        }
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 1,
          },
        });
        this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
      } else {
        this.sourceNode = this.createAmbientTestSource(this.audioContext);
      }

      this.muteGain = this.audioContext.createGain();
      this.muteGain.gain.value = 0;

      const attachedWorklet = await this.tryAttachWorklet(this.audioContext, this.sourceNode, this.muteGain);
      if (!attachedWorklet) {
        this.attachScriptProcessorFallback(this.audioContext, this.sourceNode, this.muteGain);
      }

      this.muteGain.connect(this.audioContext.destination);
      this.state = 'recording';
      this.lastWriteMs = Date.now();
    } catch (err) {
      this.stopInternalNodes();
      this.state = 'error';
      if (err instanceof Error) {
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          this.errorMessage = 'Microphone access was denied. Grant permission in iOS/browser settings or try Test Signal mode.';
        } else if (err.name === 'NotFoundError') {
          this.errorMessage = 'No microphone detected on this device. Switch to Test Signal mode to test waveform capture.';
        } else {
          this.errorMessage = err.message;
        }
      } else {
        this.errorMessage = 'Unable to start audio capture.';
      }
      throw err;
    }
  }

  public pause(): void {
    if (this.state === 'recording') {
      this.state = 'paused';
      this.currentDb = -60;
    }
  }

  public async resume(): Promise<void> {
    if (this.state === 'paused') {
      if (this.audioContext && this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }
      this.state = 'recording';
      this.lastWriteMs = Date.now();
    }
  }

  public stop(): void {
    this.stopPreview();
    this.stopInternalNodes();
    this.state = 'idle';
    this.currentDb = -60;
    this.peakHoldDb = -60;
  }

  public clearBuffer(): void {
    this.pcmRing.fill(0);
    this.peakRing.fill(0);
    this.writeIndex = 0;
    this.totalWrittenSamples = 0;
    this.peakWriteIndex = 0;
    this.totalWrittenPeaks = 0;
    this.peakSampleAccum = 0;
    this.currentBucketMax = 0;
    this.markers = [];
  }

  public addManualMarker(label = 'Bookmark'): TimelineMarker {
    const marker: TimelineMarker = {
      id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestampMs: this.lastWriteMs || Date.now(),
      label,
      kind: 'manual',
    };
    this.markers.push(marker);
    this.pruneExpiredMarkers();
    return marker;
  }

  public getMarkers(): TimelineMarker[] {
    this.pruneExpiredMarkers();
    return [...this.markers];
  }

  private pruneExpiredMarkers(): void {
    const oldestAllowedMs = (this.lastWriteMs || Date.now()) - this.bufferMinutes * 60 * 1000;
    this.markers = this.markers.filter((m) => m.timestampMs >= oldestAllowedMs);
  }

  private async tryAttachWorklet(
    ctx: AudioContext,
    source: AudioNode,
    sink: AudioNode
  ): Promise<boolean> {
    if (!ctx.audioWorklet) return false;
    try {
      const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      this.workletNode = new AudioWorkletNode(ctx, 'tapeloop-capture-processor');
      this.workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (this.state === 'recording') {
          this.ingestFloat32Frame(event.data, ctx.sampleRate);
        }
      };
      source.connect(this.workletNode);
      this.workletNode.connect(sink);
      return true;
    } catch {
      return false;
    }
  }

  private attachScriptProcessorFallback(ctx: AudioContext, source: AudioNode, sink: AudioNode): void {
    // ScriptProcessorNode fallback for older iOS WebViews where AudioWorklet is disabled
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (e) => {
      if (this.state === 'recording') {
        const input = e.inputBuffer.getChannelData(0);
        this.ingestFloat32Frame(input, ctx.sampleRate);
      }
    };
    this.scriptNode = processor;
    source.connect(processor);
    processor.connect(sink);
  }

  /**
   * Synthesizes a realistic acoustic environment with vocal-like tonal cadences
   * so users without a mic connected can immediately verify circular buffering & WAV saving.
   */
  private createAmbientTestSource(ctx: AudioContext): AudioNode {
    const mixGain = ctx.createGain();
    mixGain.gain.value = 0.55;

    // Gentle filtered room noise floor
    const noiseLen = ctx.sampleRate * 2;
    const noiseBuf = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
    const ch = noiseBuf.getChannelData(0);
    let b0 = 0;
    for (let i = 0; i < noiseLen; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.96 * b0 + white * 0.04;
      ch[i] = b0 * 0.14;
    }
    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = noiseBuf;
    noiseSrc.loop = true;
    noiseSrc.connect(mixGain);
    noiseSrc.start();

    // Expressive voice-band harmonic envelope bursts
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const toneEnv = ctx.createGain();
    osc1.type = 'triangle';
    osc2.type = 'sine';
    osc1.frequency.value = 196;
    osc2.frequency.value = 392;
    toneEnv.gain.value = 0.02;

    osc1.connect(toneEnv);
    osc2.connect(toneEnv);
    toneEnv.connect(mixGain);
    osc1.start();
    osc2.start();

    const notes = [196, 220, 246.94, 293.66, 329.63, 261.63, 174.61];
    let step = 0;
    const schedulePhrase = () => {
      if (!this.audioContext || this.audioContext.state === 'closed') return;
      const now = this.audioContext.currentTime;
      const isBurst = step % 5 !== 4;
      const baseFreq = notes[step % notes.length];
      osc1.frequency.setTargetAtTime(baseFreq, now, 0.06);
      osc2.frequency.setTargetAtTime(baseFreq * 1.5, now, 0.06);
      const targetAmp = isBurst ? 0.14 + Math.random() * 0.34 : 0.015;
      toneEnv.gain.cancelScheduledValues(now);
      toneEnv.gain.setTargetAtTime(targetAmp, now, 0.04);
      toneEnv.gain.setTargetAtTime(0.02, now + 0.32, 0.14);
      step++;
    };
    schedulePhrase();
    this.testOscTimer = window.setInterval(schedulePhrase, 650);

    return mixGain;
  }

  private ingestFloat32Frame(frame: Float32Array, inputSampleRate: number): void {
    const ratio = inputSampleRate / this.targetSampleRate;
    const ringLen = this.pcmRing.length;
    const peakRingLen = this.peakRing.length;

    let sumSq = 0;
    let countOut = 0;

    let pos = this.resampleFrac;
    while (pos < frame.length) {
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const s0 = idx === 0 && pos < 1 ? this.prevSample : frame[idx];
      const s1 = frame[Math.min(frame.length - 1, idx + 1)];
      const sampleFloat = s0 + (s1 - s0) * frac;

      const clamped = Math.max(-1, Math.min(1, sampleFloat));
      const int16 = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);

      this.pcmRing[this.writeIndex] = int16;
      this.writeIndex++;
      if (this.writeIndex >= ringLen) {
        this.writeIndex = 0;
      }
      this.totalWrittenSamples++;
      this.sessionSamples++;

      const absVal = Math.abs(clamped);
      sumSq += clamped * clamped;
      countOut++;

      if (absVal > this.currentBucketMax) {
        this.currentBucketMax = absVal;
      }
      this.peakSampleAccum++;
      if (this.peakSampleAccum >= this.samplesPerPeak) {
        this.peakRing[this.peakWriteIndex] = this.currentBucketMax;
        this.peakWriteIndex++;
        if (this.peakWriteIndex >= peakRingLen) {
          this.peakWriteIndex = 0;
        }
        this.totalWrittenPeaks++;
        this.peakSampleAccum = 0;
        this.currentBucketMax = 0;
      }

      pos += ratio;
    }

    this.resampleFrac = pos - frame.length;
    if (frame.length > 0) {
      this.prevSample = frame[frame.length - 1];
    }

    const nowMs = Date.now();
    this.lastWriteMs = nowMs;

    if (countOut > 0) {
      const rms = Math.sqrt(sumSq / countOut);
      const db = rms > 0.00001 ? Math.max(-60, Math.min(0, 20 * Math.log10(rms))) : -60;
      this.currentDb = this.currentDb * 0.45 + db * 0.55;

      if (this.currentDb >= this.peakHoldDb || nowMs - this.peakHoldDecayTs > 1400) {
        this.peakHoldDb = Math.max(this.currentDb, this.peakHoldDb - 1.2);
        if (this.currentDb >= this.peakHoldDb) {
          this.peakHoldDecayTs = nowMs;
        }
      }

      // Automatic sound peak event markers (debounced to 1 per 12s)
      if (
        this.autoEventMarkers &&
        this.currentDb >= this.eventThresholdDb &&
        nowMs - this.lastPeakMarkerMs > 12000
      ) {
        this.lastPeakMarkerMs = nowMs;
        this.markers.push({
          id: `p-${nowMs}`,
          timestampMs: nowMs,
          label: `Peak ${Math.round(this.currentDb)} dB`,
          kind: 'peak',
          peakDb: Math.round(this.currentDb),
        });
        this.pruneExpiredMarkers();
      }
    }
  }

  private readLastSamples(count: number): Int16Array {
    const ringLen = this.pcmRing.length;
    const available = Math.min(count, this.totalWrittenSamples, ringLen);
    const out = new Int16Array(available);
    if (available === 0) return out;

    const startIdx = (this.writeIndex - available + ringLen) % ringLen;
    if (startIdx + available <= ringLen) {
      out.set(this.pcmRing.subarray(startIdx, startIdx + available), 0);
    } else {
      const firstPart = ringLen - startIdx;
      out.set(this.pcmRing.subarray(startIdx, ringLen), 0);
      out.set(this.pcmRing.subarray(0, available - firstPart), firstPart);
    }
    return out;
  }

  /**
   * Extracts a precise audio segment from the circular buffer using offsets in seconds
   * measured backwards from "now" (e.g. startAgoSec = 120, endAgoSec = 0 => last 2 minutes).
   */
  public extractSegment(
    startAgoSec: number,
    endAgoSec = 0
  ): { samples: Int16Array; sampleRate: number; durationSec: number; startMs: number; endMs: number } {
    const ringLen = this.pcmRing.length;
    const availableSamples = Math.min(this.totalWrittenSamples, ringLen);
    const availableSec = availableSamples / this.targetSampleRate;

    const clampedEndAgo = Math.max(0, Math.min(availableSec, endAgoSec));
    const clampedStartAgo = Math.max(clampedEndAgo, Math.min(availableSec, startAgoSec));

    const endOffsetSamples = Math.floor(clampedEndAgo * this.targetSampleRate);
    const startOffsetSamples = Math.floor(clampedStartAgo * this.targetSampleRate);
    const lengthSamples = Math.max(0, startOffsetSamples - endOffsetSamples);

    const out = new Int16Array(lengthSamples);
    if (lengthSamples > 0) {
      const startIdx = (this.writeIndex - startOffsetSamples + ringLen * 2) % ringLen;
      if (startIdx + lengthSamples <= ringLen) {
        out.set(this.pcmRing.subarray(startIdx, startIdx + lengthSamples), 0);
      } else {
        const firstPart = ringLen - startIdx;
        out.set(this.pcmRing.subarray(startIdx, ringLen), 0);
        out.set(this.pcmRing.subarray(0, lengthSamples - firstPart), firstPart);
      }
    }

    const refNow = this.lastWriteMs || Date.now();
    return {
      samples: out,
      sampleRate: this.targetSampleRate,
      durationSec: lengthSamples / this.targetSampleRate,
      startMs: refNow - clampedStartAgo * 1000,
      endMs: refNow - clampedEndAgo * 1000,
    };
  }

  /**
   * Plays back a trimmed segment directly from the circular buffer without stopping live capture.
   */
  public async previewSegment(
    startAgoSec: number,
    endAgoSec: number,
    onEnded?: () => void
  ): Promise<boolean> {
    this.stopPreview();
    const { samples, sampleRate } = this.extractSegment(startAgoSec, endAgoSec);
    if (samples.length === 0) return false;

    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!this.audioContext || this.audioContext.state === 'closed') {
      this.audioContext = new AudioCtx();
    }
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    const audioBuf = this.audioContext.createBuffer(1, samples.length, sampleRate);
    const channelData = audioBuf.getChannelData(0);
    for (let i = 0; i < samples.length; i++) {
      channelData[i] = samples[i] / 32768;
    }

    const src = this.audioContext.createBufferSource();
    src.buffer = audioBuf;
    src.connect(this.audioContext.destination);
    src.onended = () => {
      if (this.previewSource === src) {
        this.previewSource = null;
      }
      onEnded?.();
    };
    this.previewSource = src;
    src.start();
    return true;
  }

  public stopPreview(): void {
    if (this.previewSource) {
      try {
        this.previewSource.stop();
        this.previewSource.disconnect();
      } catch {
        // Already stopped
      }
      this.previewSource = null;
    }
  }

  /**
   * Produces a fast downsampled peak array covering the requested timeline window
   * (aligned to the right edge = "Now").
   */
  public getTimelineSnapshot(windowSeconds: number, barCount: number): TimelineSnapshot {
    const capacitySeconds = this.pcmRing.length / this.targetSampleRate;
    const bufferedSeconds = Math.min(capacitySeconds, this.totalWrittenSamples / this.targetSampleRate);
    const effectiveWindow = Math.max(10, Math.min(capacitySeconds, windowSeconds));
    const peaksOut = new Float32Array(barCount);

    const totalPeaksInWindow = Math.floor(effectiveWindow * PEAKS_PER_SECOND);
    const availablePeaks = Math.min(this.totalWrittenPeaks, this.peakRing.length);
    const ringLen = this.peakRing.length;

    const peaksPerBar = totalPeaksInWindow / barCount;

    for (let b = 0; b < barCount; b++) {
      // Bar index barCount-1 is "Now", index 0 is "-effectiveWindow"
      const agoStartPeak = Math.floor((barCount - b) * peaksPerBar);
      const agoEndPeak = Math.floor((barCount - 1 - b) * peaksPerBar);

      if (agoEndPeak >= availablePeaks) {
        peaksOut[b] = 0;
        continue;
      }

      const clampedAgoStart = Math.min(availablePeaks, Math.max(agoEndPeak + 1, agoStartPeak));
      let maxPeak = 0;
      const step = Math.max(1, Math.floor((clampedAgoStart - agoEndPeak) / 16));
      for (let ago = agoEndPeak; ago < clampedAgoStart; ago += step) {
        const idx = (this.peakWriteIndex - 1 - ago + ringLen * 2) % ringLen;
        const val = this.peakRing[idx];
        if (val > maxPeak) maxPeak = val;
      }
      peaksOut[b] = maxPeak;
    }

    this.pruneExpiredMarkers();
    return {
      peaks: peaksOut,
      bufferedSeconds,
      capacitySeconds,
      windowSeconds: effectiveWindow,
      nowMs: this.lastWriteMs || Date.now(),
      currentDb: this.currentDb,
      peakHoldDb: this.peakHoldDb,
      markers: this.markers,
    };
  }

  private stopInternalNodes(): void {
    if (this.testOscTimer !== null) {
      window.clearInterval(this.testOscTimer);
      this.testOscTimer = null;
    }
    if (this.workletNode) {
      try {
        this.workletNode.port.onmessage = null;
        this.workletNode.disconnect();
      } catch {
        // Ignore
      }
      this.workletNode = null;
    }
    if (this.scriptNode) {
      try {
        this.scriptNode.onaudioprocess = null;
        this.scriptNode.disconnect();
      } catch {
        // Ignore
      }
      this.scriptNode = null;
    }
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        // Ignore
      }
      this.sourceNode = null;
    }
    if (this.muteGain) {
      try {
        this.muteGain.disconnect();
      } catch {
        // Ignore
      }
      this.muteGain = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
  }

  public dispose(): void {
    this.stop();
    if (this.audioContext && this.audioContext.state !== 'closed') {
      void this.audioContext.close();
      this.audioContext = null;
    }
  }
}
