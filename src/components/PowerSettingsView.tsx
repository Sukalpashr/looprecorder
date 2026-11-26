import React, { useState } from 'react';
import {
  BatteryCharging,
  Moon,
  Sun,
  Smartphone,
  ShieldCheck,
  Mic,
  Radio,
  Package,
  Check,
} from 'lucide-react';
import {
  SAMPLE_RATE_SPECS,
  type InputSourceMode,
  type PowerSettings,
  type SampleRateProfile,
  type WaveformFpsMode,
} from '../types/audio';
import type { BackgroundPowerStatus } from '../hooks/useBackgroundPower';
import { formatBytes } from '../engine/wavEncoder';
import { downloadNativeIOSProjectZip } from '../engine/iosProjectExporter';
import { PWAInstallButton } from './PWAInstallButton';

interface PowerSettingsViewProps {
  settings: PowerSettings;
  onChange: (patch: Partial<PowerSettings>) => void;
  onToggleLowPower: (enabled: boolean) => void;
  powerStatus: BackgroundPowerStatus;
  isDark: boolean;
  onToggleTheme: () => void;
  onEnterOledStandby: () => void;
  lastCheckpointAt: number | null;
}

const BUFFER_PRESETS = [5, 10, 15, 20, 30];
const CHECKPOINT_PRESETS = [
  { value: 0, label: 'Off' },
  { value: 5, label: '5m' },
  { value: 10, label: '10m' },
  { value: 15, label: '15m' },
];

export const PowerSettingsView: React.FC<PowerSettingsViewProps> = ({
  settings,
  onChange,
  onToggleLowPower,
  powerStatus,
  isDark,
  onToggleTheme,
  onEnterOledStandby,
  lastCheckpointAt,
}) => {
  const [downloadedZip, setDownloadedZip] = useState(false);
  const rateSpec = SAMPLE_RATE_SPECS[settings.sampleRateProfile];
  const estimatedRamBytes = settings.bufferMinutes * 60 * rateSpec.bytesPerSecond;

  const handleDownloadIOSZip = async () => {
    await downloadNativeIOSProjectZip();
    setDownloadedZip(true);
    setTimeout(() => setDownloadedZip(false), 2600);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      {/* Left Column: Buffer Architecture & Quality */}
      <div className="lg:col-span-7 space-y-6">
        {/* Circular Buffer Window */}
        <section className="rounded-2xl border border-neutral-200 dark:border-[#272B34] bg-white dark:bg-[#14161A] p-5 sm:p-6">
          <div className="flex items-baseline justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-[#111318] dark:text-[#F3F4F6]">
                Circular Buffer Window
              </h2>
              <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                Continuous rolling memory kept ready for instant backward saving.
              </p>
            </div>
            <div className="text-right shrink-0">
              <div className="font-mono text-2xl font-semibold tabular-nums text-[#111318] dark:text-[#F3F4F6]">
                {settings.bufferMinutes} min
              </div>
              <div className="font-mono text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
                {formatBytes(estimatedRamBytes)} RAM
              </div>
            </div>
          </div>

          <div className="mt-5">
            <input
              type="range"
              min={5}
              max={30}
              step={1}
              value={settings.bufferMinutes}
              onChange={(e) => onChange({ bufferMinutes: Number(e.target.value) })}
              aria-label="Circular buffer duration in minutes"
              className="tapeloop-slider w-full accent-[#FF3B30] bg-neutral-200 dark:bg-[#272B34] rounded-full h-1"
            />
            <div className="mt-3 grid grid-cols-5 gap-2">
              {BUFFER_PRESETS.map((mins) => {
                const active = settings.bufferMinutes === mins;
                return (
                  <button
                    key={mins}
                    type="button"
                    onClick={() => onChange({ bufferMinutes: mins })}
                    className={`min-h-[44px] rounded-xl font-mono text-xs font-semibold tabular-nums transition ${
                      active
                        ? 'bg-[#111318] text-white dark:bg-[#F3F4F6] dark:text-[#0B0C0E]'
                        : 'bg-neutral-100 dark:bg-[#1C1F26] text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-[#272B34]'
                    }`}
                  >
                    {mins}m
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        {/* Sample Rate & Memory Profile */}
        <section className="rounded-2xl border border-neutral-200 dark:border-[#272B34] bg-white dark:bg-[#14161A] p-5 sm:p-6">
          <h2 className="text-base font-semibold text-[#111318] dark:text-[#F3F4F6]">
            Audio Fidelity & Memory Footprint
          </h2>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Lower sample rates dramatically reduce iOS memory pressure and prevent Jetsam termination during 24/7 operation.
          </p>

          <div className="mt-4 space-y-2.5">
            {(Object.keys(SAMPLE_RATE_SPECS) as SampleRateProfile[]).map((key) => {
              const spec = SAMPLE_RATE_SPECS[key];
              const active = settings.sampleRateProfile === key;
              const memForCurrentWindow = settings.bufferMinutes * 60 * spec.bytesPerSecond;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => onChange({ sampleRateProfile: key })}
                  className={`w-full text-left rounded-xl p-4 border transition flex items-start justify-between gap-4 ${
                    active
                      ? 'border-[#FF3B30] bg-[#FF3B30]/5 dark:bg-[#FF3B30]/10'
                      : 'border-neutral-200 dark:border-[#272B34] hover:border-neutral-300 dark:hover:border-[#3A404D]'
                  }`}
                >
                  <div>
                    <div className="text-sm font-semibold text-[#111318] dark:text-[#F3F4F6]">
                      {spec.label}
                    </div>
                    <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400 leading-relaxed">
                      {spec.description}
                    </p>
                  </div>
                  <div className="font-mono text-xs font-semibold tabular-nums text-neutral-600 dark:text-neutral-300 shrink-0">
                    {formatBytes(memForCurrentWindow)}
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        {/* Input Source & Event Detection */}
        <section className="rounded-2xl border border-neutral-200 dark:border-[#272B34] bg-white dark:bg-[#14161A] p-5 sm:p-6 space-y-5">
          <div>
            <h2 className="text-base font-semibold text-[#111318] dark:text-[#F3F4F6]">
              Input Source & Smart Event Markers
            </h2>
            <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
              Automatically tag loud speech or acoustic spikes on your timeline so key moments are easy to locate.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2 p-1 rounded-xl bg-neutral-100 dark:bg-[#0B0C0E]">
            {(
              [
                { id: 'microphone', label: 'Device Microphone', icon: Mic },
                { id: 'ambient-test', label: 'Test Signal', icon: Radio },
              ] as { id: InputSourceMode; label: string; icon: typeof Mic }[]
            ).map(({ id, label, icon: Icon }) => {
              const active = settings.inputSource === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => onChange({ inputSource: id })}
                  className={`min-h-[44px] rounded-lg px-3 py-2 text-xs font-semibold flex items-center justify-center gap-2 transition whitespace-nowrap ${
                    active
                      ? 'bg-white dark:bg-[#1C1F26] text-[#111318] dark:text-white shadow-sm'
                      : 'text-neutral-500 hover:text-[#111318] dark:hover:text-white'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>

          <div className="pt-2 border-t border-neutral-100 dark:border-[#1E222A] space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-medium text-[#111318] dark:text-[#F3F4F6]">
                  Auto Sound-Peak Markers
                </div>
                <div className="text-xs text-neutral-500 dark:text-neutral-400">
                  Marks loud events above threshold on the rolling waveform
                </div>
              </div>
              <ToggleSwitch
                checked={settings.autoEventMarkers}
                onChange={(v) => onChange({ autoEventMarkers: v })}
                label="Toggle auto sound peak markers"
              />
            </div>

            {settings.autoEventMarkers && (
              <div>
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <span className="text-neutral-500 dark:text-neutral-400">Trigger Threshold</span>
                  <span className="font-mono font-semibold tabular-nums text-[#111318] dark:text-[#F3F4F6]">
                    {settings.eventThresholdDb} dB
                  </span>
                </div>
                <input
                  type="range"
                  min={-38}
                  max={-6}
                  step={1}
                  value={settings.eventThresholdDb}
                  onChange={(e) => onChange({ eventThresholdDb: Number(e.target.value) })}
                  aria-label="Peak marker threshold in decibels"
                  className="tapeloop-slider w-full accent-[#FF3B30] bg-neutral-200 dark:bg-[#272B34] rounded-full h-1"
                />
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Right Column: 24/7 Battery Optimization & iOS Continuity */}
      <div className="lg:col-span-5 space-y-6">
        <section className="rounded-2xl border border-neutral-200 dark:border-[#272B34] bg-white dark:bg-[#14161A] p-5 sm:p-6 space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-[#111318] dark:text-[#F3F4F6]">
                24/7 Battery & Continuity
              </h2>
              <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                Minimize CPU, GPU, and RAM draw to prevent iOS background termination.
              </p>
            </div>
            {powerStatus.batterySupported && powerStatus.batteryLevel !== null && (
              <div className="flex items-center gap-1.5 font-mono text-xs font-semibold tabular-nums text-neutral-600 dark:text-neutral-300 shrink-0">
                <BatteryCharging className="w-4 h-4" aria-hidden="true" />
                <span>
                  {powerStatus.batteryLevel}%{powerStatus.batteryCharging ? ' Chg' : ''}
                </span>
              </div>
            )}
          </div>

          {/* Master Low-Power Preset */}
          <div className="rounded-xl bg-neutral-50 dark:bg-[#0B0C0E] border border-neutral-200 dark:border-[#272B34] p-4 flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-semibold text-[#111318] dark:text-[#F3F4F6]">
                Low-Power 24/7 Mode
              </div>
              <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                Locks 16 kHz voice PCM, 15 fps canvas, and background audio anchor
              </div>
            </div>
            <ToggleSwitch
              checked={settings.lowPowerMode}
              onChange={onToggleLowPower}
              label="Toggle Low-Power 24/7 Mode"
            />
          </div>

          {/* Granular Power Toggles */}
          <div className="divide-y divide-neutral-100 dark:divide-[#1E222A]">
            <div className="py-3.5 flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-medium text-[#111318] dark:text-[#F3F4F6]">
                  Screen Wake Lock
                </div>
                <div className="text-xs text-neutral-500 dark:text-neutral-400">
                  {powerStatus.wakeLockSupported
                    ? powerStatus.wakeLockActive
                      ? 'Active — preventing display sleep suspension'
                      : 'Ready — engages automatically while recording'
                    : 'Not exposed by this browser; use OLED Standby'}
                </div>
              </div>
              <ToggleSwitch
                checked={settings.wakeLockEnabled}
                onChange={(v) => onChange({ wakeLockEnabled: v })}
                label="Toggle Screen Wake Lock"
              />
            </div>

            <div className="py-3.5 flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-medium text-[#111318] dark:text-[#F3F4F6]">
                  Background Keep-Alive & Lock Screen
                </div>
                <div className="text-xs text-neutral-500 dark:text-neutral-400">
                  {powerStatus.keepAliveActive
                    ? 'Active — Media Session anchored for background continuity'
                    : 'Maintains silent audio session & iOS Lock Screen controls'}
                </div>
              </div>
              <ToggleSwitch
                checked={settings.backgroundKeepAlive}
                onChange={(v) => onChange({ backgroundKeepAlive: v })}
                label="Toggle Background Keep-Alive"
              />
            </div>

            <div className="py-3.5 space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-[#111318] dark:text-[#F3F4F6]">
                  Waveform Refresh Rate
                </div>
                <span className="font-mono text-xs text-neutral-500 dark:text-neutral-400">
                  {settings.waveformFps === 0 ? 'Paused (0 fps)' : `${settings.waveformFps} fps`}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    { fps: 60, label: '60 fps Smooth' },
                    { fps: 15, label: '15 fps Eco' },
                    { fps: 0, label: '0 fps Freeze' },
                  ] as { fps: WaveformFpsMode; label: string }[]
                ).map((item) => (
                  <button
                    key={item.fps}
                    type="button"
                    onClick={() => onChange({ waveformFps: item.fps })}
                    className={`min-h-[40px] rounded-xl text-xs font-semibold transition whitespace-nowrap ${
                      settings.waveformFps === item.fps
                        ? 'bg-[#111318] text-white dark:bg-[#F3F4F6] dark:text-[#0B0C0E]'
                        : 'bg-neutral-100 dark:bg-[#1C1F26] text-neutral-600 dark:text-neutral-300'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="py-3.5 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-medium text-[#111318] dark:text-[#F3F4F6]">
                    Auto-Checkpoint Recovery
                  </div>
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">
                    Writes a rolling snapshot to device storage against sudden termination
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {CHECKPOINT_PRESETS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => onChange({ autoCheckpointMinutes: opt.value })}
                    className={`min-h-[40px] rounded-xl font-mono text-xs font-semibold transition ${
                      settings.autoCheckpointMinutes === opt.value
                        ? 'bg-[#111318] text-white dark:bg-[#F3F4F6] dark:text-[#0B0C0E]'
                        : 'bg-neutral-100 dark:bg-[#1C1F26] text-neutral-600 dark:text-neutral-300'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {lastCheckpointAt && (
                <p className="text-xs font-mono text-neutral-500 dark:text-neutral-400">
                  Last recovery checkpoint saved at{' '}
                  {new Date(lastCheckpointAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </p>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={onEnterOledStandby}
            className="w-full min-h-[46px] rounded-xl border border-neutral-200 dark:border-[#272B34] bg-neutral-50 dark:bg-[#0B0C0E] text-sm font-semibold text-[#111318] dark:text-[#F3F4F6] hover:bg-neutral-100 dark:hover:bg-[#1C1F26] flex items-center justify-center gap-2 transition"
          >
            <Moon className="w-4 h-4" aria-hidden="true" />
            <span>Launch OLED Pocket Standby</span>
          </button>
        </section>

        {/* iOS Home Screen & Appearance Card */}
        <section className="rounded-2xl border border-neutral-200 dark:border-[#272B34] bg-white dark:bg-[#14161A] p-5 sm:p-6 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-neutral-100 dark:bg-[#1C1F26] flex items-center justify-center text-[#111318] dark:text-[#F3F4F6]">
                {isDark ? <Moon className="w-5 h-5" /> : <Sun className="w-5 h-5" />}
              </div>
              <div>
                <div className="text-sm font-semibold text-[#111318] dark:text-[#F3F4F6]">
                  Display Theme
                </div>
                <div className="text-xs text-neutral-500 dark:text-neutral-400">
                  {isDark ? 'OLED Obsidian Dark (Lowest power)' : 'Daylight High-Contrast Light'}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={onToggleTheme}
              className="min-h-[40px] px-3.5 py-2 rounded-xl bg-neutral-100 dark:bg-[#1C1F26] text-xs font-semibold text-[#111318] dark:text-[#F3F4F6] hover:opacity-90 transition whitespace-nowrap"
            >
              {isDark ? 'Switch to Light' : 'Switch to OLED Dark'}
            </button>
          </div>

          <div className="pt-4 border-t border-neutral-100 dark:border-[#1E222A] space-y-3">
            <div className="flex items-start gap-3">
              <Smartphone className="w-5 h-5 text-neutral-500 shrink-0 mt-0.5" aria-hidden="true" />
              <div>
                <h3 className="text-sm font-semibold text-[#111318] dark:text-[#F3F4F6]">
                  iOS Standalone Installation
                </h3>
                <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400 leading-relaxed">
                  Install TapeLoop to your iPhone Home Screen via Safari for dedicated offline storage, Lock Screen audio transport, and full-screen OLED standby.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
              <ShieldCheck className="w-4 h-4 shrink-0 text-emerald-500" aria-hidden="true" />
              <span>100% on-device PCM processing. Audio never leaves your device.</span>
            </div>
            <PWAInstallButton variant="full" />
          </div>

          <div className="pt-4 border-t border-neutral-100 dark:border-[#1E222A] space-y-3">
            <div className="flex items-start gap-3">
              <Package className="w-5 h-5 text-neutral-500 shrink-0 mt-0.5" aria-hidden="true" />
              <div>
                <h3 className="text-sm font-semibold text-[#111318] dark:text-[#F3F4F6]">
                  Native iOS App &amp; .ipa Builder
                </h3>
                <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400 leading-relaxed">
                  Download the native SwiftUI + AVAudioEngine Xcode project with true{' '}
                  <span className="font-mono">UIBackgroundModes: audio</span>, Files app storage, and a GitHub Actions macOS workflow that compiles{' '}
                  <span className="font-mono">TapeLoop-unsigned.ipa</span> for AltStore, SideStore, Sideloadly, or Xcode.
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={handleDownloadIOSZip}
              className="w-full min-h-[46px] px-4 py-2.5 rounded-xl bg-[#FF3B30] hover:bg-[#E6352B] text-white text-sm font-semibold flex items-center justify-center gap-2 active:scale-[0.98] transition whitespace-nowrap"
            >
              {downloadedZip ? (
                <>
                  <Check className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span>Downloaded TapeLoop-iOS-IPA-Project.zip</span>
                </>
              ) : (
                <>
                  <Package className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span>Download Native iOS (.ipa) Project</span>
                </>
              )}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
};

interface ToggleSwitchProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}

const ToggleSwitch: React.FC<ToggleSwitchProps> = ({ checked, onChange, label }) => {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF3B30] focus-visible:ring-offset-2 dark:focus-visible:ring-offset-[#14161A] ${
        checked ? 'bg-[#FF3B30]' : 'bg-neutral-300 dark:bg-[#2C313C]'
      }`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );
};
