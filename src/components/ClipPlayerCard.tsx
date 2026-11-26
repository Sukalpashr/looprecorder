import React, { useEffect, useRef, useState } from 'react';
import { Play, Pause, Share2, Download, Trash2, Check, Pencil, X } from 'lucide-react';
import type { SavedClipMeta } from '../types/audio';
import { getClipBlobFromDB } from '../engine/clipStorage';
import {
  exportClipToDevice,
  formatBytes,
  formatClockTime,
  formatDuration,
} from '../engine/wavEncoder';

interface ClipPlayerCardProps {
  clip: SavedClipMeta;
  isDark: boolean;
  isPlaying: boolean;
  onRequestPlay: (id: string | null) => void;
  onUpdateMeta: (id: string, updates: { title: string; notes: string }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

export const ClipPlayerCard: React.FC<ClipPlayerCardProps> = ({
  clip,
  isDark,
  isPlaying,
  onRequestPlay,
  onUpdateMeta,
  onDelete,
}) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [progress, setProgress] = useState(0); // 0..1
  const [currentTime, setCurrentTime] = useState(0);
  const [exportState, setExportState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(clip.title);
  const [draftNotes, setDraftNotes] = useState(clip.notes);

  // Sync audio playback when parent toggles active playing clip
  useEffect(() => {
    let cancelled = false;

    const startPlayback = async () => {
      try {
        if (!objectUrlRef.current) {
          const blob = await getClipBlobFromDB(clip.id);
          if (!blob || cancelled) {
            onRequestPlay(null);
            return;
          }
          objectUrlRef.current = URL.createObjectURL(blob);
        }

        if (!audioRef.current) {
          const audio = new Audio(objectUrlRef.current);
          audio.addEventListener('timeupdate', () => {
            if (!audio.duration || !Number.isFinite(audio.duration)) return;
            setCurrentTime(audio.currentTime);
            setProgress(audio.currentTime / audio.duration);
          });
          audio.addEventListener('ended', () => {
            setProgress(0);
            setCurrentTime(0);
            onRequestPlay(null);
          });
          audioRef.current = audio;
        }

        await audioRef.current.play();
      } catch {
        onRequestPlay(null);
      }
    };

    if (isPlaying) {
      void startPlayback();
    } else if (audioRef.current) {
      audioRef.current.pause();
    }

    return () => {
      cancelled = true;
    };
  }, [clip.id, isPlaying, onRequestPlay]);

  // Cleanup object URL on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, []);

  // Draw crisp mini scrubbable waveform
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = canvas.clientWidth || 320;
    const height = 44;
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const peaks = clip.peaks.length > 0 ? clip.peaks : Array(80).fill(0.12);
    const barCount = Math.min(peaks.length, Math.floor(width / 4));
    const step = peaks.length / barCount;
    const barW = Math.max(2, width / barCount - 1.5);
    const midY = height / 2;

    for (let i = 0; i < barCount; i++) {
      const idx = Math.floor(i * step);
      const p = Math.pow(Math.min(1, (peaks[idx] || 0.05) * 1.45), 0.72);
      const halfH = Math.max(2, p * (height * 0.44));
      const ratio = i / barCount;
      const x = (i / barCount) * width;

      if (ratio <= progress && progress > 0) {
        ctx.fillStyle = '#FF3B30';
      } else {
        ctx.fillStyle = isDark ? 'rgba(229, 231, 235, 0.35)' : 'rgba(17, 19, 24, 0.25)';
      }
      ctx.fillRect(x, midY - halfH, barW, halfH * 2);
    }

    if (progress > 0) {
      const px = progress * width;
      ctx.fillStyle = '#FF3B30';
      ctx.fillRect(px - 1, 2, 2, height - 4);
    }

    ctx.restore();
  }, [clip.peaks, isDark, progress]);

  const handleScrub = async (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setProgress(ratio);
    setCurrentTime(ratio * clip.durationSec);

    if (audioRef.current && Number.isFinite(audioRef.current.duration)) {
      audioRef.current.currentTime = ratio * audioRef.current.duration;
    } else {
      const blob = await getClipBlobFromDB(clip.id);
      if (blob) {
        if (!objectUrlRef.current) {
          objectUrlRef.current = URL.createObjectURL(blob);
        }
        if (!audioRef.current) {
          audioRef.current = new Audio(objectUrlRef.current);
        }
        audioRef.current.currentTime = ratio * clip.durationSec;
      }
    }
  };

  const handleExport = async (preferShare: boolean) => {
    setExportState('saving');
    try {
      const blob = await getClipBlobFromDB(clip.id);
      if (!blob) {
        setExportState('idle');
        return;
      }
      const res = await exportClipToDevice(clip, blob, preferShare);
      setExportState(res === 'cancelled' ? 'idle' : 'saved');
      if (res !== 'cancelled') {
        setTimeout(() => setExportState('idle'), 2000);
      }
    } catch {
      setExportState('idle');
    }
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = draftTitle.trim() || clip.title;
    await onUpdateMeta(clip.id, { title: trimmed, notes: draftNotes.trim() });
    setIsEditing(false);
  };

  const canShareFiles =
    typeof navigator !== 'undefined' &&
    'share' in navigator &&
    'canShare' in navigator;

  return (
    <article className="rounded-2xl border border-neutral-200 dark:border-[#272B34] bg-white dark:bg-[#14161A] p-4 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {isEditing ? (
            <form onSubmit={handleSaveEdit} className="space-y-2">
              <input
                type="text"
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                aria-label="Clip title"
                className="w-full rounded-lg border border-neutral-300 dark:border-[#343A46] bg-neutral-50 dark:bg-[#0B0C0E] px-3 py-2 text-sm font-semibold text-[#111318] dark:text-[#F3F4F6] focus:outline-none focus:ring-2 focus:ring-[#FF3B30]"
                autoFocus
              />
              <input
                type="text"
                value={draftNotes}
                onChange={(e) => setDraftNotes(e.target.value)}
                placeholder="Add a note about this moment..."
                aria-label="Clip notes"
                className="w-full rounded-lg border border-neutral-300 dark:border-[#343A46] bg-neutral-50 dark:bg-[#0B0C0E] px-3 py-2 text-xs text-neutral-700 dark:text-neutral-300 focus:outline-none focus:ring-2 focus:ring-[#FF3B30]"
              />
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  className="min-h-[36px] px-3 py-1.5 rounded-lg bg-[#111318] dark:bg-[#F3F4F6] text-white dark:text-[#0B0C0E] text-xs font-semibold"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDraftTitle(clip.title);
                    setDraftNotes(clip.notes);
                    setIsEditing(false);
                  }}
                  className="min-h-[36px] px-3 py-1.5 rounded-lg text-xs font-medium text-neutral-500 hover:text-neutral-900 dark:hover:text-white"
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-[#111318] dark:text-[#F3F4F6] truncate">
                  {clip.title}
                </h3>
                {clip.isCheckpoint && (
                  <span className="text-xs font-medium text-amber-600 dark:text-amber-400 shrink-0">
                    Recovery Checkpoint
                  </span>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-neutral-500 dark:text-neutral-400 font-mono tabular-nums">
                <span>
                  {formatClockTime(clip.capturedStartMs)}–{formatClockTime(clip.capturedEndMs)}
                </span>
                <span aria-hidden="true">·</span>
                <span>{formatDuration(clip.durationSec)}</span>
                <span aria-hidden="true">·</span>
                <span>{(clip.sampleRate / 1000).toFixed(clip.sampleRate % 1000 === 0 ? 0 : 1)} kHz</span>
                <span aria-hidden="true">·</span>
                <span>{formatBytes(clip.sizeBytes)}</span>
              </div>
              {clip.notes && (
                <p className="mt-1.5 text-xs text-neutral-600 dark:text-neutral-400 line-clamp-2">
                  {clip.notes}
                </p>
              )}
            </>
          )}
        </div>

        {!isEditing && (
          <button
            type="button"
            onClick={() => setIsEditing(true)}
            aria-label={`Edit ${clip.title}`}
            className="min-h-[40px] min-w-[40px] -mr-1 -mt-1 flex items-center justify-center rounded-xl text-neutral-400 hover:text-[#111318] dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-[#1C1F26] transition"
          >
            <Pencil className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Interactive Play + Scrubbable Waveform Row */}
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => onRequestPlay(isPlaying ? null : clip.id)}
          aria-label={isPlaying ? `Pause ${clip.title}` : `Play ${clip.title}`}
          className={`min-h-[44px] min-w-[44px] rounded-xl flex items-center justify-center shrink-0 transition active:scale-95 ${
            isPlaying
              ? 'bg-[#FF3B30] text-white'
              : 'bg-neutral-100 dark:bg-[#1C1F26] text-[#111318] dark:text-[#F3F4F6] hover:bg-neutral-200 dark:hover:bg-[#272B34]'
          }`}
        >
          {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current ml-0.5" />}
        </button>

        <div className="flex-1 min-w-0">
          <canvas
            ref={canvasRef}
            onPointerDown={handleScrub}
            className="w-full h-[44px] block cursor-pointer"
            aria-label="Scrub audio playback position"
          />
        </div>

        <span className="font-mono text-xs tabular-nums text-neutral-500 dark:text-neutral-400 shrink-0 w-12 text-right">
          {formatDuration(isPlaying || currentTime > 0 ? currentTime : clip.durationSec)}
        </span>
      </div>

      {/* Device Storage Export & Delete Row */}
      <div className="mt-3 pt-3 border-t border-neutral-100 dark:border-[#1E222A] flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => handleExport(canShareFiles)}
            disabled={exportState === 'saving'}
            className="inline-flex items-center gap-1.5 min-h-[40px] px-3.5 py-2 rounded-xl bg-neutral-100 dark:bg-[#1C1F26] text-xs font-semibold text-[#111318] dark:text-[#F3F4F6] hover:bg-neutral-200 dark:hover:bg-[#272B34] active:scale-[0.98] transition whitespace-nowrap"
          >
            {exportState === 'saved' ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-500" aria-hidden="true" />
                <span>Saved</span>
              </>
            ) : canShareFiles ? (
              <>
                <Share2 className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Save to Files</span>
              </>
            ) : (
              <>
                <Download className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Download WAV</span>
              </>
            )}
          </button>

          {canShareFiles && (
            <button
              type="button"
              onClick={() => handleExport(false)}
              aria-label="Direct WAV download"
              className="inline-flex items-center gap-1.5 min-h-[40px] px-3 py-2 rounded-xl text-xs font-medium text-neutral-600 dark:text-neutral-400 hover:text-[#111318] dark:hover:text-white transition whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" aria-hidden="true" />
              <span>WAV</span>
            </button>
          )}
        </div>

        {confirmDelete ? (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void onDelete(clip.id)}
              className="min-h-[36px] px-3 py-1.5 rounded-lg bg-[#FF3B30] text-white text-xs font-semibold whitespace-nowrap"
            >
              Delete
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              aria-label="Cancel delete"
              className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg text-neutral-400 hover:text-neutral-900 dark:hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            aria-label={`Delete ${clip.title}`}
            className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl text-neutral-400 hover:text-[#FF3B30] hover:bg-red-500/10 transition"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>
    </article>
  );
};
