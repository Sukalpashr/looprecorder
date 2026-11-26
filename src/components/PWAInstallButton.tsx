import React, { useState } from 'react';
import { Download, Share, PlusSquare, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  variant?: 'compact' | 'full';
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({ variant = 'compact' }) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  const handleClick = async () => {
    if (isInstallable) {
      await install();
    } else {
      setShowIOSGuide(true);
    }
  };

  // In full variant (Settings / Power view), always show install / iOS Home Screen setup
  if (variant === 'compact' && !isInstallable && !isIOS) {
    return null;
  }

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        className={
          variant === 'full'
            ? 'inline-flex items-center justify-center gap-2 min-h-[44px] px-4 py-2.5 rounded-xl bg-[#111318] text-white dark:bg-[#F3F4F6] dark:text-[#0B0C0E] text-sm font-semibold hover:opacity-90 active:scale-[0.98] transition whitespace-nowrap shrink-0'
            : 'inline-flex items-center justify-center gap-1.5 min-h-[40px] px-3.5 py-2 rounded-lg border border-neutral-200 dark:border-[#272B34] bg-white dark:bg-[#14161A] text-xs font-semibold text-[#111318] dark:text-[#F3F4F6] hover:bg-neutral-50 dark:hover:bg-[#1C1F26] transition whitespace-nowrap shrink-0'
        }
      >
        <Download className="w-4 h-4 shrink-0" aria-hidden="true" />
        <span>{isInstallable ? 'Install App' : 'Install on iOS'}</span>
      </button>

      {showIOSGuide && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="ios-install-title"
          onClick={() => setShowIOSGuide(false)}
        >
          <div
            className="w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl bg-white dark:bg-[#14161A] border border-neutral-200 dark:border-[#272B34] p-6 pb-8 sm:pb-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-10 h-1 bg-neutral-300 dark:bg-neutral-700 rounded-full mx-auto mb-5 sm:hidden" />
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3
                  id="ios-install-title"
                  className="text-lg font-semibold text-[#111318] dark:text-[#F3F4F6]"
                >
                  Install TapeLoop on iPhone
                </h3>
                <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                  Add to your Home Screen for full-screen standalone capture, offline audio storage, and uninterrupted sessions.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                aria-label="Close installation guide"
                className="min-h-[44px] min-w-[44px] -mr-2 -mt-2 flex items-center justify-center rounded-xl text-neutral-500 hover:text-neutral-900 dark:hover:text-white transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <ol className="mt-5 space-y-4 text-sm text-[#111318] dark:text-neutral-200">
              <li className="flex items-start gap-3">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-neutral-100 dark:bg-[#1C1F26] font-mono text-xs font-semibold">
                  1
                </span>
                <div className="leading-relaxed">
                  Open this page in <strong>Safari</strong> and tap the{' '}
                  <span className="inline-flex items-center gap-1 font-semibold">
                    <Share className="w-4 h-4 inline" aria-hidden="true" /> Share
                  </span>{' '}
                  button in the bottom toolbar.
                </div>
              </li>
              <li className="flex items-start gap-3">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-neutral-100 dark:bg-[#1C1F26] font-mono text-xs font-semibold">
                  2
                </span>
                <div className="leading-relaxed">
                  Scroll down and tap{' '}
                  <span className="inline-flex items-center gap-1 font-semibold">
                    <PlusSquare className="w-4 h-4 inline" aria-hidden="true" /> Add to Home Screen
                  </span>
                  .
                </div>
              </li>
              <li className="flex items-start gap-3">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-neutral-100 dark:bg-[#1C1F26] font-mono text-xs font-semibold">
                  3
                </span>
                <div className="leading-relaxed">
                  Launch <strong>TapeLoop</strong> from your Home Screen and enable <strong>Low-Power 24/7</strong> in Power settings for prolonged unattended recording.
                </div>
              </li>
            </ol>

            <button
              type="button"
              onClick={() => setShowIOSGuide(false)}
              className="mt-6 w-full min-h-[44px] rounded-xl bg-[#111318] dark:bg-[#F3F4F6] text-white dark:text-[#0B0C0E] text-sm font-semibold hover:opacity-90 transition"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </>
  );
};
