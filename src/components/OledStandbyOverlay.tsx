import React, { useEffect, useRef, useState } from 'react';
import { Bookmark, Sun } from 'lucide-react';
import { formatDuration } from '../engine/wavEncoder';

interface OledStandbyOverlayProps {
  isOpen: boolean;
  isRecording: boolean;
  bufferedSeconds: number;
  capacitySeconds: number;
  wakeLockActive: boolean;
  onQuickSave2m: () => Promise<void>;
  onExit: () => void;
}

export const OledStandbyOverlay: React.FC<OledStandbyOverlayProps> = ({
  isOpen,
  isRecording,
  bufferedSeconds,
  capacitySeconds,
  wakeLockActive,
  onQuickSave2m,
  onExit,
}) => {
  const [clock, setClock] = useState(() =>
    new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  );
  const [shiftY, setShiftY] = useState(0);
  const [holdProgress, setHoldProgress] = useState(0);
  const [savedNotice, setSavedNotice] = useState(false);
  const holdTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const id = window.setInterval(() => {
      const now = new Date();
      setClock(now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      // Gentle OLED burn-in pixel shift every minute
      setShiftY(((now.getMinutes() % 5) - 2) * 8);
    }, 15000);
    return () => window.clearInterval(id);
  }, [isOpen]);

  const stopHold = () => {
    if (holdTimerRef.current !== null) {
      window.clearInterval(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    setHoldProgress(0);
  };

  const startHold = () => {
    stopHold();
    const start = performance.now();
    holdTimerRef.current = window.setInterval(() => {
      const pct = Math.min(100, ((performance.now() - start) / 700) * 100);
      setHoldProgress(pct);
      if (pct >= 100) {
        stopHold();
        onExit();
      }
    }, 30);
  };

  useEffect(() => {
    return () => stopHold();
  }, []);

  if (!isOpen) return null;

  const handleQuickSave = async () => {
    await onQuickSave2m();
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 2200);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black text-neutral-400 flex flex-col items-center justify-between px-6 py-12 select-none"
      role="dialog"
      aria-modal="true"
      aria-label="OLED Low-Power Standby Mode"
    >
      <div className="text-center space-y-1">
        <p className="text-xs font-medium text-neutral-500">
          OLED Standby · Display & Canvas Rendering Paused
        </p>
        <p className="font-mono text-xs tabular-nums text-neutral-600">
          {isRecording ? 'Circular Buffer Active' : 'Recorder Paused'}
          {' · '}
          {wakeLockActive ? 'Wake Lock Engaged' : 'Standard Power'}
        </p>
      </div>

      <div
        className="text-center transition-transform duration-700"
        style={{ transform: `translateY(${shiftY}px)` }}
      >
        <div className="font-mono text-6xl sm:text-7xl font-medium tracking-tight tabular-nums text-neutral-300/80">
          {clock}
        </div>
        <div className="mt-4 font-mono text-sm tabular-nums text-red-500/80">
          Buffer {formatDuration(bufferedSeconds)} / {formatDuration(capacitySeconds)}
        </div>
        {savedNotice && (
          <p className="mt-3 text-xs font-medium text-emerald-500/90">
            Saved last 2 minutes to device storage
          </p>
        )}
      </div>

      <div className="w-full max-w-xs space-y-3">
        <button
          type="button"
          onClick={handleQuickSave}
          disabled={bufferedSeconds < 1}
          className="w-full min-h-[52px] rounded-2xl border border-neutral-800 bg-neutral-950 text-neutral-300 text-sm font-medium flex items-center justify-center gap-2 active:bg-neutral-900 disabled:opacity-30 transition"
        >
          <Bookmark className="w-4 h-4 text-red-500/80" aria-hidden="true" />
          <span>Quick Save Last 2m</span>
        </button>

        <button
          type="button"
          onPointerDown={startHold}
          onPointerUp={stopHold}
          onPointerLeave={stopHold}
          onPointerCancel={stopHold}
          onDoubleClick={onExit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') {
              onExit();
            }
          }}
          className="relative overflow-hidden w-full min-h-[52px] rounded-2xl border border-neutral-900 bg-black text-neutral-500 text-sm font-medium flex items-center justify-center gap-2 transition"
        >
          <div
            className="absolute inset-y-0 left-0 bg-neutral-800/70 transition-none"
            style={{ width: `${holdProgress}%` }}
          />
          <Sun className="w-4 h-4 relative z-10" aria-hidden="true" />
          <span className="relative z-10">Hold or Double-Tap to Wake Screen</span>
        </button>
      </div>
    </div>
  );
};
