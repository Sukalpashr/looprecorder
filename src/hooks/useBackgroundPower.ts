import { useEffect, useRef, useState } from 'react';
import { createSilentWavBlobUrl } from '../engine/wavEncoder';

interface WakeLockSentinelLike {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: string, listener: () => void) => void;
}

interface BatteryManagerLike extends EventTarget {
  level: number;
  charging: boolean;
}

interface UseBackgroundPowerParams {
  isRecording: boolean;
  wakeLockEnabled: boolean;
  backgroundKeepAlive: boolean;
  bufferMinutes: number;
  onQuickSaveFromLockScreen: () => void;
  onPauseFromLockScreen: () => void;
  onResumeFromLockScreen: () => void;
}

export interface BackgroundPowerStatus {
  wakeLockSupported: boolean;
  wakeLockActive: boolean;
  keepAliveActive: boolean;
  batterySupported: boolean;
  batteryLevel: number | null;
  batteryCharging: boolean | null;
}

export function useBackgroundPower({
  isRecording,
  wakeLockEnabled,
  backgroundKeepAlive,
  bufferMinutes,
  onQuickSaveFromLockScreen,
  onPauseFromLockScreen,
  onResumeFromLockScreen,
}: UseBackgroundPowerParams): BackgroundPowerStatus {
  const [wakeLockActive, setWakeLockActive] = useState(false);
  const [keepAliveActive, setKeepAliveActive] = useState(false);
  const [batterySupported, setBatterySupported] = useState(false);
  const [batteryLevel, setBatteryLevel] = useState<number | null>(null);
  const [batteryCharging, setBatteryCharging] = useState<boolean | null>(null);

  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const keepAliveAudioRef = useRef<HTMLAudioElement | null>(null);
  const silentUrlRef = useRef<string | null>(null);

  const callbacksRef = useRef({
    onQuickSaveFromLockScreen,
    onPauseFromLockScreen,
    onResumeFromLockScreen,
  });
  callbacksRef.current = {
    onQuickSaveFromLockScreen,
    onPauseFromLockScreen,
    onResumeFromLockScreen,
  };

  const wakeLockSupported =
    typeof navigator !== 'undefined' && 'wakeLock' in navigator;

  // 1. Real Screen Wake Lock management + visibilitychange re-acquisition for iOS Safari
  useEffect(() => {
    let cancelled = false;

    const releaseWakeLock = async () => {
      if (wakeLockRef.current) {
        try {
          await wakeLockRef.current.release();
        } catch {
          // Already released
        }
        wakeLockRef.current = null;
      }
      if (!cancelled) setWakeLockActive(false);
    };

    const requestWakeLock = async () => {
      if (!wakeLockSupported || !isRecording || !wakeLockEnabled) {
        await releaseWakeLock();
        return;
      }
      if (document.visibilityState !== 'visible') return;
      try {
        const nav = navigator as Navigator & {
          wakeLock: { request: (type: 'screen') => Promise<WakeLockSentinelLike> };
        };
        const sentinel = await nav.wakeLock.request('screen');
        if (cancelled) {
          await sentinel.release();
          return;
        }
        wakeLockRef.current = sentinel;
        setWakeLockActive(true);
        sentinel.addEventListener('release', () => {
          if (!cancelled) setWakeLockActive(false);
        });
      } catch {
        if (!cancelled) setWakeLockActive(false);
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && isRecording && wakeLockEnabled) {
        void requestWakeLock();
      }
    };

    void requestWakeLock();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      void releaseWakeLock();
    };
  }, [isRecording, wakeLockEnabled, wakeLockSupported]);

  // 2. Silent Audio Keep-Alive Anchor + Media Session Lock Screen Metadata
  useEffect(() => {
    const teardownKeepAlive = () => {
      if (keepAliveAudioRef.current) {
        keepAliveAudioRef.current.pause();
        keepAliveAudioRef.current.removeAttribute('src');
        keepAliveAudioRef.current = null;
      }
      if (silentUrlRef.current) {
        URL.revokeObjectURL(silentUrlRef.current);
        silentUrlRef.current = null;
      }
      setKeepAliveActive(false);
    };

    if (!isRecording || !backgroundKeepAlive) {
      teardownKeepAlive();
      return;
    }

    const url = createSilentWavBlobUrl(3);
    silentUrlRef.current = url;
    const audio = new Audio(url);
    audio.loop = true;
    audio.volume = 0.01;
    audio.setAttribute('playsinline', 'true');
    keepAliveAudioRef.current = audio;

    audio
      .play()
      .then(() => {
        setKeepAliveActive(true);
        if ('mediaSession' in navigator) {
          try {
            navigator.mediaSession.metadata = new MediaMetadata({
              title: `TapeLoop · ${bufferMinutes}m Circular Buffer`,
              artist: 'Continuous Background Capture',
              album: '24/7 Audio Loop',
            });
            navigator.mediaSession.playbackState = 'playing';
            navigator.mediaSession.setActionHandler('pause', () => {
              callbacksRef.current.onPauseFromLockScreen();
            });
            navigator.mediaSession.setActionHandler('play', () => {
              callbacksRef.current.onResumeFromLockScreen();
            });
            navigator.mediaSession.setActionHandler('seekbackward', () => {
              callbacksRef.current.onQuickSaveFromLockScreen();
            });
          } catch {
            // MediaSession partially unsupported
          }
        }
      })
      .catch(() => {
        setKeepAliveActive(false);
      });

    return () => {
      teardownKeepAlive();
      if ('mediaSession' in navigator) {
        try {
          navigator.mediaSession.playbackState = 'none';
        } catch {
          // Ignore
        }
      }
    };
  }, [isRecording, backgroundKeepAlive, bufferMinutes]);

  // 3. Battery Status API (when exposed by device browser)
  useEffect(() => {
    let battery: BatteryManagerLike | null = null;
    let mounted = true;

    const updateBattery = () => {
      if (!mounted || !battery) return;
      setBatteryLevel(Math.round(battery.level * 100));
      setBatteryCharging(battery.charging);
    };

    const nav = navigator as Navigator & {
      getBattery?: () => Promise<BatteryManagerLike>;
    };

    if (typeof nav.getBattery === 'function') {
      nav
        .getBattery()
        .then((b) => {
          if (!mounted) return;
          battery = b;
          setBatterySupported(true);
          updateBattery();
          b.addEventListener('levelchange', updateBattery);
          b.addEventListener('chargingchange', updateBattery);
        })
        .catch(() => {
          if (mounted) setBatterySupported(false);
        });
    }

    return () => {
      mounted = false;
      if (battery) {
        battery.removeEventListener('levelchange', updateBattery);
        battery.removeEventListener('chargingchange', updateBattery);
      }
    };
  }, []);

  return {
    wakeLockSupported,
    wakeLockActive,
    keepAliveActive,
    batterySupported,
    batteryLevel,
    batteryCharging,
  };
}
