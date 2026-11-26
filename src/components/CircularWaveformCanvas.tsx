import React, { useEffect, useRef, useState, useCallback } from 'react';
import { CircularAudioEngine } from '../engine/CircularAudioEngine';
import { formatDuration } from '../engine/wavEncoder';
import type { TimelineMarker, WaveformFpsMode } from '../types/audio';

export interface TrimSelection {
  startAgoSec: number; // larger number (further back in time)
  endAgoSec: number; // smaller number (closer to now)
}

interface CircularWaveformCanvasProps {
  engine: CircularAudioEngine;
  isRecording: boolean;
  isDark: boolean;
  waveformFps: WaveformFpsMode;
  isSuspended: boolean; // true during OLED standby or hidden tab
  windowSeconds: number;
  bufferedSeconds: number;
  capacitySeconds: number;
  trimMode: boolean;
  trimSelection: TrimSelection;
  onTrimChange: (next: TrimSelection) => void;
  onEnterTrimMode: () => void;
}

export const CircularWaveformCanvas: React.FC<CircularWaveformCanvasProps> = ({
  engine,
  isRecording,
  isDark,
  waveformFps,
  isSuspended,
  windowSeconds,
  bufferedSeconds,
  capacitySeconds,
  trimMode,
  trimSelection,
  onTrimChange,
  onEnterTrimMode,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [canvasWidth, setCanvasWidth] = useState(640);
  const [draggingHandle, setDraggingHandle] = useState<'start' | 'end' | 'range' | null>(null);
  const dragOriginRef = useRef<{ pointerAgo: number; startAgo: number; endAgo: number } | null>(null);
  const [markers, setMarkers] = useState<TimelineMarker[]>([]);

  // Observe container resize for crisp HiDPI canvas scaling
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0) {
        setCanvasWidth(Math.floor(rect.width));
      }
    };
    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const height = 216;
    const width = Math.max(280, canvasWidth);

    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }

    ctx.save();
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = isDark ? '#111318' : '#FFFFFF';
    ctx.fillRect(0, 0, width, height);

    const padTop = 26;
    const padBottom = 26;
    const waveHeight = height - padTop - padBottom;
    const midY = padTop + waveHeight / 2;

    // Subtle horizontal center & quarter reference lines
    ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(17,19,24,0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(width, midY);
    ctx.moveTo(0, padTop);
    ctx.lineTo(width, padTop);
    ctx.moveTo(0, height - padBottom);
    ctx.lineTo(width, height - padBottom);
    ctx.stroke();

    // Vertical time ticks (4 divisions)
    const tickCount = 4;
    ctx.font = '500 10px "IBM Plex Mono", monospace';
    ctx.fillStyle = isDark ? 'rgba(156,163,175,0.75)' : 'rgba(100,116,139,0.85)';
    for (let i = 0; i <= tickCount; i++) {
      const x = Math.round((width * i) / tickCount) + 0.5;
      const agoSec = windowSeconds * (1 - i / tickCount);
      if (i > 0 && i < tickCount) {
        ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(17,19,24,0.05)';
        ctx.beginPath();
        ctx.moveTo(x, padTop);
        ctx.lineTo(x, height - padBottom);
        ctx.stroke();
      }
      const label = i === tickCount ? 'NOW' : `-${formatDuration(agoSec)}`;
      ctx.textAlign = i === 0 ? 'left' : i === tickCount ? 'right' : 'center';
      ctx.fillText(label, i === 0 ? 6 : i === tickCount ? width - 6 : x, height - 8);
    }

    // Fetch downsampled peak snapshot from ring buffer
    const barPitch = 4;
    const barWidth = 2.5;
    const barCount = Math.max(40, Math.floor(width / barPitch));
    const snapshot = engine.getTimelineSnapshot(windowSeconds, barCount);
    setMarkers((prev) =>
      prev.length === snapshot.markers.length &&
      prev[prev.length - 1]?.id === snapshot.markers[snapshot.markers.length - 1]?.id
        ? prev
        : snapshot.markers
    );

    // Highlight active trim region behind bars
    if (trimMode) {
      const xStart = Math.max(
        0,
        Math.min(width, width * (1 - trimSelection.startAgoSec / windowSeconds))
      );
      const xEnd = Math.max(
        0,
        Math.min(width, width * (1 - trimSelection.endAgoSec / windowSeconds))
      );
      const selLeft = Math.min(xStart, xEnd);
      const selWidth = Math.max(2, Math.abs(xEnd - xStart));

      ctx.fillStyle = isDark ? 'rgba(255, 59, 48, 0.14)' : 'rgba(255, 59, 48, 0.10)';
      ctx.fillRect(selLeft, padTop, selWidth, waveHeight);
    }

    // Render waveform bars
    const bufferedRatio = Math.min(1, snapshot.bufferedSeconds / windowSeconds);
    const activeStartX = width * (1 - bufferedRatio);

    for (let i = 0; i < barCount; i++) {
      const x = i * barPitch + 1;
      const agoAtBar = windowSeconds * (1 - x / width);
      const peak = snapshot.peaks[i];
      const inBuffer = x >= activeStartX - 2;
      const inSelection =
        trimMode &&
        agoAtBar <= trimSelection.startAgoSec &&
        agoAtBar >= trimSelection.endAgoSec;

      if (!inBuffer) {
        // Unfilled pre-buffer timeline baseline dot
        ctx.fillStyle = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(17,19,24,0.10)';
        ctx.fillRect(x, midY - 1, barWidth, 2);
        continue;
      }

      // Perceptual amplitude curve for speech readability
      const boosted = Math.pow(Math.min(1, peak * 1.45), 0.72);
      const halfH = Math.max(2, boosted * (waveHeight * 0.46));

      if (inSelection) {
        ctx.fillStyle = '#FF3B30';
      } else if (peak > 0.72) {
        ctx.fillStyle = isDark ? '#F59E0B' : '#D97706';
      } else {
        ctx.fillStyle = isDark ? 'rgba(229, 231, 235, 0.82)' : 'rgba(17, 19, 24, 0.78)';
      }

      ctx.fillRect(x, midY - halfH, barWidth, halfH * 2);
    }

    // Render timeline markers (peak events & manual bookmarks) along top rail
    for (const m of snapshot.markers) {
      const agoSec = (snapshot.nowMs - m.timestampMs) / 1000;
      if (agoSec < 0 || agoSec > windowSeconds) continue;
      const mx = width * (1 - agoSec / windowSeconds);

      ctx.fillStyle = m.kind === 'manual' ? '#FF3B30' : '#F59E0B';
      // Small downward marker triangle at top rail
      ctx.beginPath();
      ctx.moveTo(mx, padTop - 3);
      ctx.lineTo(mx - 4, padTop - 10);
      ctx.lineTo(mx + 4, padTop - 10);
      ctx.closePath();
      ctx.fill();

      // Subtle vertical guide line
      ctx.strokeStyle =
        m.kind === 'manual'
          ? 'rgba(255, 59, 48, 0.35)'
          : 'rgba(245, 158, 11, 0.22)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(mx, padTop);
      ctx.lineTo(mx, height - padBottom);
      ctx.stroke();
    }

    // Live playhead needle at right edge ("NOW")
    ctx.fillStyle = isRecording ? '#FF3B30' : isDark ? '#6B7280' : '#94A3B8';
    ctx.fillRect(width - 2, padTop - 6, 2, waveHeight + 12);

    // Top-left window info label
    ctx.font = '500 10px "IBM Plex Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = isDark ? 'rgba(156,163,175,0.85)' : 'rgba(100,116,139,0.9)';
    const statusLabel =
      waveformFps === 0
        ? 'CANVAS PAUSED (BATTERY SAVER) · AUDIO RECORDING'
        : `WINDOW ${formatDuration(windowSeconds)} · BUFFERED ${formatDuration(snapshot.bufferedSeconds)} / ${formatDuration(capacitySeconds)}`;
    ctx.fillText(statusLabel, 8, 15);

    ctx.restore();
  }, [
    canvasWidth,
    capacitySeconds,
    engine,
    isDark,
    isRecording,
    trimMode,
    trimSelection.endAgoSec,
    trimSelection.startAgoSec,
    waveformFps,
    windowSeconds,
  ]);

  // Animation loop with real FPS throttling (60fps / 15fps / 0fps Battery Saver)
  useEffect(() => {
    // Always draw at least one frame when props change
    drawFrame();

    if (isSuspended || waveformFps === 0) {
      return;
    }

    let rafId = 0;
    let lastDraw = 0;
    const minFrameMs = waveformFps === 15 ? 1000 / 15 : 1000 / 60;

    const tick = (now: number) => {
      if (now - lastDraw >= minFrameMs) {
        lastDraw = now;
        drawFrame();
      }
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [drawFrame, isSuspended, waveformFps]);

  const pointerToAgoSec = (clientX: number): number => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const maxSelectable = Math.max(1, Math.min(windowSeconds, bufferedSeconds || windowSeconds));
    const rawAgo = windowSeconds * (1 - ratio);
    return Math.max(0, Math.min(maxSelectable, rawAgo));
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>, target?: 'start' | 'end') => {
    const maxAgo = Math.max(1, Math.min(windowSeconds, bufferedSeconds));
    if (bufferedSeconds < 1) return;

    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const ago = pointerToAgoSec(e.clientX);

    if (target) {
      setDraggingHandle(target);
      dragOriginRef.current = {
        pointerAgo: ago,
        startAgo: trimSelection.startAgoSec,
        endAgo: trimSelection.endAgoSec,
      };
      return;
    }

    // Dragging directly on the canvas creates or repositions a custom trim window
    if (!trimMode) {
      onEnterTrimMode();
      const span = Math.min(maxAgo, Math.max(10, Math.min(60, maxAgo * 0.4)));
      const nextStart = Math.min(maxAgo, Math.max(span, ago + span / 2));
      const nextEnd = Math.max(0, nextStart - span);
      onTrimChange({ startAgoSec: nextStart, endAgoSec: nextEnd });
      setDraggingHandle('range');
      dragOriginRef.current = { pointerAgo: ago, startAgo: nextStart, endAgo: nextEnd };
    } else if (ago <= trimSelection.startAgoSec && ago >= trimSelection.endAgoSec) {
      setDraggingHandle('range');
      dragOriginRef.current = {
        pointerAgo: ago,
        startAgo: trimSelection.startAgoSec,
        endAgo: trimSelection.endAgoSec,
      };
    } else {
      // Snap nearest handle to tap point
      const distStart = Math.abs(ago - trimSelection.startAgoSec);
      const distEnd = Math.abs(ago - trimSelection.endAgoSec);
      if (distStart < distEnd) {
        onTrimChange({
          startAgoSec: Math.max(trimSelection.endAgoSec + 1, Math.min(maxAgo, ago)),
          endAgoSec: trimSelection.endAgoSec,
        });
        setDraggingHandle('start');
      } else {
        onTrimChange({
          startAgoSec: trimSelection.startAgoSec,
          endAgoSec: Math.min(trimSelection.startAgoSec - 1, Math.max(0, ago)),
        });
        setDraggingHandle('end');
      }
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingHandle) return;
    const maxAgo = Math.max(1, Math.min(windowSeconds, bufferedSeconds));
    const ago = pointerToAgoSec(e.clientX);

    if (draggingHandle === 'start') {
      const nextStart = Math.max(trimSelection.endAgoSec + 1, Math.min(maxAgo, ago));
      onTrimChange({ startAgoSec: nextStart, endAgoSec: trimSelection.endAgoSec });
    } else if (draggingHandle === 'end') {
      const nextEnd = Math.min(trimSelection.startAgoSec - 1, Math.max(0, ago));
      onTrimChange({ startAgoSec: trimSelection.startAgoSec, endAgoSec: nextEnd });
    } else if (draggingHandle === 'range' && dragOriginRef.current) {
      const delta = ago - dragOriginRef.current.pointerAgo;
      const span = dragOriginRef.current.startAgo - dragOriginRef.current.endAgo;
      let nextEnd = dragOriginRef.current.endAgo + delta;
      let nextStart = nextEnd + span;
      if (nextEnd < 0) {
        nextEnd = 0;
        nextStart = Math.min(maxAgo, span);
      }
      if (nextStart > maxAgo) {
        nextStart = maxAgo;
        nextEnd = Math.max(0, maxAgo - span);
      }
      onTrimChange({ startAgoSec: nextStart, endAgoSec: nextEnd });
    }
  };

  const handlePointerUp = () => {
    setDraggingHandle(null);
    dragOriginRef.current = null;
  };

  const startPercent = Math.max(0, Math.min(100, (1 - trimSelection.startAgoSec / windowSeconds) * 100));
  const endPercent = Math.max(0, Math.min(100, (1 - trimSelection.endAgoSec / windowSeconds) * 100));

  return (
    <div className="space-y-2">
      <div
        ref={containerRef}
        onPointerDown={(e) => handlePointerDown(e)}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        className="relative w-full h-[216px] rounded-2xl overflow-hidden border border-neutral-200 dark:border-[#272B34] bg-white dark:bg-[#111318] select-none touch-none cursor-crosshair"
        aria-label="Live circular audio waveform timeline"
      >
        <canvas ref={canvasRef} className="w-full h-full block" />

        {/* Draggable Start & End Trim Handles with generous 44px touch targets */}
        {trimMode && bufferedSeconds >= 1 && (
          <>
            <div
              role="slider"
              aria-label="Segment start time"
              aria-valuemin={0}
              aria-valuemax={Math.round(bufferedSeconds)}
              aria-valuenow={Math.round(trimSelection.startAgoSec)}
              tabIndex={0}
              style={{ left: `${startPercent}%` }}
              onPointerDown={(e) => {
                e.stopPropagation();
                handlePointerDown(e, 'start');
              }}
              className="absolute top-[26px] bottom-[26px] -translate-x-1/2 w-11 flex items-center justify-center cursor-ew-resize z-10 group"
            >
              <div className="w-0.5 h-full bg-[#FF3B30]" />
              <div className="absolute top-1/2 -translate-y-1/2 w-4 h-9 rounded-md bg-[#FF3B30] shadow-md flex items-center justify-center group-active:scale-110 transition-transform">
                <div className="w-0.5 h-4 bg-white/90 rounded-full" />
              </div>
            </div>

            <div
              role="slider"
              aria-label="Segment end time"
              aria-valuemin={0}
              aria-valuemax={Math.round(bufferedSeconds)}
              aria-valuenow={Math.round(trimSelection.endAgoSec)}
              tabIndex={0}
              style={{ left: `${endPercent}%` }}
              onPointerDown={(e) => {
                e.stopPropagation();
                handlePointerDown(e, 'end');
              }}
              className="absolute top-[26px] bottom-[26px] -translate-x-1/2 w-11 flex items-center justify-center cursor-ew-resize z-10 group"
            >
              <div className="w-0.5 h-full bg-[#FF3B30]" />
              <div className="absolute top-1/2 -translate-y-1/2 w-4 h-9 rounded-md bg-[#FF3B30] shadow-md flex items-center justify-center group-active:scale-110 transition-transform">
                <div className="w-0.5 h-4 bg-white/90 rounded-full" />
              </div>
            </div>
          </>
        )}
      </div>

      {/* Subtle unboxed legend / marker summary line */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-500 dark:text-neutral-400 px-1">
        <span>
          {trimMode
            ? `Drag handles to trim · Selected ${formatDuration(
                Math.max(0, trimSelection.startAgoSec - trimSelection.endAgoSec)
              )} (-${formatDuration(trimSelection.startAgoSec)} to -${formatDuration(
                trimSelection.endAgoSec
              )})`
            : bufferedSeconds >= 1
              ? 'Drag across waveform to trim a custom segment'
              : 'Start loop to fill circular buffer'}
        </span>
        {markers.length > 0 && (
          <span className="font-mono tabular-nums">
            {markers.length} {markers.length === 1 ? 'marker' : 'markers'} in buffer
          </span>
        )}
      </div>
    </div>
  );
};
