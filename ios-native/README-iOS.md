# TapeLoop Native iOS App (.ipa Builder)

This package contains the complete native SwiftUI + `AVAudioEngine` iOS source code for **TapeLoop**, configured with true `UIBackgroundModes: audio` for uninterrupted 24/7 circular-buffer recording, Files app integration (`UIFileSharingEnabled`), thermal/battery throttling, and automatic phone-call/AirPods interruption recovery.

## Option 1: Build `.ipa` in the Cloud with GitHub Actions (No Mac Required)

1. Create a new GitHub repository and upload the contents of this zip (keeping `ios-native/` and `.github/workflows/build-ipa.yml` at the repository root).
2. Open the **Actions** tab on GitHub and click **Build iOS IPA** → **Run workflow**.
3. Wait ~2 minutes for the `macos-14` runner to finish, then download **TapeLoop-iOS-IPA** (`TapeLoop-unsigned.ipa`) from the workflow Artifacts section.
4. Install `TapeLoop-unsigned.ipa` onto your iPhone using **AltStore**, **SideStore**, or **Sideloadly** (free Apple ID works—no paid Apple Developer account required).

## Option 2: Build Directly on a Mac with Xcode

```bash
brew install xcodegen
cd ios-native
xcodegen generate
open TapeLoop.xcodeproj
```

1. In Xcode, select the **TapeLoop** target → **Signing & Capabilities**.
2. Pick your Apple ID under **Team** and change the Bundle Identifier if prompted.
3. Connect your iPhone and press **Run (⌘R)** — or choose **Product → Archive** to export a signed `.ipa`.

## Saved Audio Location on iPhone

Saved `.wav` segments are written directly to **Files → On My iPhone → TapeLoop → Clips**, and can also be exported via the native iOS Share Sheet inside the app.
