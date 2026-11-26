import projectYml from '../../ios-native/project.yml?raw';
import infoPlist from '../../ios-native/TapeLoop/Info.plist?raw';
import tapeLoopAppSwift from '../../ios-native/TapeLoop/TapeLoopApp.swift?raw';
import circularBufferSwift from '../../ios-native/TapeLoop/CircularAudioBuffer.swift?raw';
import recorderManagerSwift from '../../ios-native/TapeLoop/AudioRecorderManager.swift?raw';
import waveformViewSwift from '../../ios-native/TapeLoop/WaveformView.swift?raw';
import contentViewSwift from '../../ios-native/TapeLoop/ContentView.swift?raw';
import assetsRootJson from '../../ios-native/TapeLoop/Assets.xcassets/Contents.json?raw';
import appIconJson from '../../ios-native/TapeLoop/Assets.xcassets/AppIcon.appiconset/Contents.json?raw';
import accentColorJson from '../../ios-native/TapeLoop/Assets.xcassets/AccentColor.colorset/Contents.json?raw';
import appIconPngUrl from '../../ios-native/TapeLoop/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png?url';
import readmeIOS from '../../ios-native/README-iOS.md?raw';
import buildIpaWorkflow from '../../.github/workflows/build-ipa.yml?raw';
import { buildZipBlob, type ZipFileEntry } from './zipBuilder';

export async function downloadNativeIOSProjectZip(): Promise<void> {
  const entries: ZipFileEntry[] = [
    { path: 'README-iOS.md', content: readmeIOS },
    { path: '.github/workflows/build-ipa.yml', content: buildIpaWorkflow },
    { path: 'ios-native/project.yml', content: projectYml },
    { path: 'ios-native/TapeLoop/Info.plist', content: infoPlist },
    { path: 'ios-native/TapeLoop/TapeLoopApp.swift', content: tapeLoopAppSwift },
    { path: 'ios-native/TapeLoop/CircularAudioBuffer.swift', content: circularBufferSwift },
    { path: 'ios-native/TapeLoop/AudioRecorderManager.swift', content: recorderManagerSwift },
    { path: 'ios-native/TapeLoop/WaveformView.swift', content: waveformViewSwift },
    { path: 'ios-native/TapeLoop/ContentView.swift', content: contentViewSwift },
    { path: 'ios-native/TapeLoop/Assets.xcassets/Contents.json', content: assetsRootJson },
    { path: 'ios-native/TapeLoop/Assets.xcassets/AppIcon.appiconset/Contents.json', content: appIconJson },
    { path: 'ios-native/TapeLoop/Assets.xcassets/AccentColor.colorset/Contents.json', content: accentColorJson },
  ];

  try {
    const resp = await fetch(appIconPngUrl);
    if (resp.ok) {
      const iconBytes = new Uint8Array(await resp.arrayBuffer());
      entries.push({
        path: 'ios-native/TapeLoop/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png',
        content: iconBytes,
      });
    }
  } catch {
    // Proceed with text assets if fetch is unavailable
  }

  const blob = buildZipBlob(entries);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'TapeLoop-iOS-IPA-Project.zip';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 1500);
}
