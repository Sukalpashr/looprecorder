import SwiftUI

private enum TimelineZoom: String, CaseIterable, Identifiable {
    case oneMin = "1m"
    case fiveMin = "5m"
    case full = "Full"

    var id: String { rawValue }
}

struct ContentView: View {
    @EnvironmentObject private var recorder: AudioRecorderManager

    @State private var selectedTab: Int = 0
    @State private var zoomSelection: TimelineZoom = .fiveMin
    @State private var trimMode: Bool = false
    @State private var trimStartAgo: Double = 60
    @State private var trimEndAgo: Double = 0
    @State private var oledStandby: Bool = false

    private let vermilion = Color(red: 1.0, green: 59.0 / 255.0, blue: 48.0 / 255.0)
    private let bgDark = Color(red: 11 / 255, green: 12 / 255, blue: 14 / 255)
    private let cardDark = Color(red: 20 / 255, green: 22 / 255, blue: 26 / 255)

    var body: some View {
        ZStack {
            TabView(selection: $selectedTab) {
                recorderTab
                    .tabItem {
                        Label("Recorder", systemImage: "waveform")
                    }
                    .tag(0)

                libraryTab
                    .tabItem {
                        Label("Clips", systemImage: "folder")
                    }
                    .tag(1)

                powerTab
                    .tabItem {
                        Label("Power", systemImage: "battery.100.bolt")
                    }
                    .tag(2)
            }
            .tint(vermilion)

            // Toast notification
            if let toast = recorder.statusToast {
                VStack {
                    Spacer()
                    Text(toast)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.black)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .padding(.bottom, 74)
                }
                .transition(.opacity)
                .allowsHitTesting(false)
            }

            // Pure black OLED Pocket Standby overlay
            if oledStandby {
                oledStandbyOverlay
            }
        }
    }

    // MARK: - Tab 1: Recorder

    private var recorderTab: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    if let err = recorder.errorMessage {
                        Text(err)
                            .font(.footnote)
                            .foregroundStyle(vermilion)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(14)
                            .background(vermilion.opacity(0.12), in: RoundedRectangle(cornerRadius: 14))
                    }

                    // Timecode & Metering Card
                    VStack(alignment: .leading, spacing: 14) {
                        HStack {
                            Text(recorder.isRecording ? "Recording Circular Loop" : (recorder.isPaused ? "Loop Paused" : "Standby"))
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(recorder.isRecording ? vermilion : .secondary)
                            Text("·")
                                .foregroundStyle(.secondary)
                            Text(recorder.sampleRateOption.shortLabel)
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(.secondary)
                            Spacer()
                            Text(recorder.isRecording ? String(format: "%.1f dB", recorder.currentDb) : "--.- dB")
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(.secondary)
                        }

                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(AudioRecorderManager.formatTime(recorder.bufferedSeconds))
                                .font(.system(size: 42, weight: .semibold, design: .monospaced))
                                .monospacedDigit()
                            Text("/ \(AudioRecorderManager.formatTime(recorder.capacitySeconds))")
                                .font(.system(size: 20, weight: .regular, design: .monospaced))
                                .foregroundStyle(.secondary)
                        }

                        // Window zoom selector
                        Picker("Timeline Window", selection: $zoomSelection) {
                            Text("1m").tag(TimelineZoom.oneMin)
                            Text("5m").tag(TimelineZoom.fiveMin)
                            Text("Full \(recorder.bufferMinutes)m").tag(TimelineZoom.full)
                        }
                        .pickerStyle(.segmented)
                        .onChange(of: zoomSelection) { newVal in
                            switch newVal {
                            case .oneMin:
                                recorder.windowSeconds = min(60.0, recorder.capacitySeconds)
                            case .fiveMin:
                                recorder.windowSeconds = min(300.0, recorder.capacitySeconds)
                            case .full:
                                recorder.windowSeconds = recorder.capacitySeconds
                            }
                        }

                        WaveformView(
                            peaks: recorder.waveformPeaks,
                            bufferedSeconds: recorder.bufferedSeconds,
                            windowSeconds: recorder.windowSeconds,
                            isRecording: recorder.isRecording,
                            trimMode: $trimMode,
                            startAgoSec: $trimStartAgo,
                            endAgoSec: $trimEndAgo
                        )

                        if trimMode {
                            HStack {
                                Text("Selected \(AudioRecorderManager.formatTime(max(0, trimStartAgo - trimEndAgo)))")
                                    .font(.caption.monospacedDigit())
                                    .foregroundStyle(.secondary)
                                Spacer()
                                Button("Save Selection") {
                                    recorder.saveSegment(startAgoSec: trimStartAgo, endAgoSec: trimEndAgo)
                                    trimMode = false
                                }
                                .buttonStyle(.borderedProminent)
                                .tint(vermilion)
                                .controlSize(.small)
                            }
                        }
                    }
                    .padding(16)
                    .background(cardDark, in: RoundedRectangle(cornerRadius: 20, style: .continuous))

                    // Instant Retroactive Save Grid
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Instant Retroactive Save")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)

                        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                            quickSaveButton("Save Last 30s", seconds: 30)
                            quickSaveButton("Save Last 2m", seconds: 120)
                            quickSaveButton("Save Last 5m", seconds: 300)

                            Button {
                                if !trimMode {
                                    let avail = max(1, min(recorder.windowSeconds, recorder.bufferedSeconds))
                                    trimStartAgo = min(avail, max(5, min(60, avail * 0.6)))
                                    trimEndAgo = 0
                                }
                                trimMode.toggle()
                            } label: {
                                Label(trimMode ? "Exit Trim" : "Custom Trim", systemImage: "scissors")
                                    .font(.subheadline.weight(.semibold))
                                    .frame(maxWidth: .infinity, minHeight: 48)
                                    .background(trimMode ? vermilion.opacity(0.18) : cardDark, in: RoundedRectangle(cornerRadius: 14))
                                    .foregroundStyle(trimMode ? vermilion : .white)
                            }
                            .disabled(recorder.bufferedSeconds < 1)
                        }
                    }

                    // Main Transport Controls
                    HStack(spacing: 12) {
                        Button {
                            recorder.togglePause()
                        } label: {
                            Label(
                                recorder.isRecording ? "Pause Loop" : (recorder.isPaused ? "Resume Loop" : "Start 24/7 Loop"),
                                systemImage: recorder.isRecording ? "pause.fill" : "mic.fill"
                            )
                            .font(.headline)
                            .frame(maxWidth: .infinity, minHeight: 54)
                            .background(recorder.isRecording ? Color.white : vermilion, in: RoundedRectangle(cornerRadius: 16))
                            .foregroundStyle(recorder.isRecording ? .black : .white)
                        }

                        if recorder.isRecording || recorder.isPaused {
                            Button {
                                recorder.stopLoop()
                            } label: {
                                Image(systemName: "stop.fill")
                                    .frame(width: 54, height: 54)
                                    .background(cardDark, in: RoundedRectangle(cornerRadius: 16))
                                    .foregroundStyle(.white)
                            }
                            .accessibilityLabel("Stop Recording")
                        }
                    }
                }
                .padding(16)
            }
            .background(bgDark.ignoresSafeArea())
            .navigationTitle("TapeLoop")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        oledStandby = true
                    } label: {
                        Label("OLED", systemImage: "moon.fill")
                            .font(.caption.weight(.semibold))
                    }
                }
            }
        }
    }

    private func quickSaveButton(_ title: String, seconds: Double) -> some View {
        Button {
            recorder.saveSegment(startAgoSec: seconds, endAgoSec: 0)
        } label: {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: 48)
                .background(cardDark, in: RoundedRectangle(cornerRadius: 14))
                .foregroundStyle(.white)
        }
        .disabled(recorder.bufferedSeconds < 1)
    }

    // MARK: - Tab 2: Saved Clips Library

    private var libraryTab: some View {
        NavigationStack {
            Group {
                if recorder.savedClips.isEmpty {
                    VStack(spacing: 10) {
                        Text("No Saved Segments Yet")
                            .font(.headline)
                        Text("Saved clips are stored directly in On My iPhone -> TapeLoop -> Clips as WAV files.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 32)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(bgDark.ignoresSafeArea())
                } else {
                    List {
                        ForEach(recorder.savedClips) { clip in
                            HStack(spacing: 12) {
                                Button {
                                    recorder.togglePlayback(clip: clip)
                                } label: {
                                    Image(systemName: recorder.playingClipID == clip.id ? "stop.fill" : "play.fill")
                                        .frame(width: 40, height: 40)
                                        .background(recorder.playingClipID == clip.id ? vermilion : Color.white.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
                                        .foregroundStyle(.white)
                                }
                                .buttonStyle(.plain)

                                VStack(alignment: .leading, spacing: 3) {
                                    Text(clip.title)
                                        .font(.subheadline.weight(.semibold))
                                        .lineLimit(1)
                                    Text("\(AudioRecorderManager.formatTime(clip.durationSec)) · \(ByteCountFormatter.string(fromByteCount: clip.sizeBytes, countStyle: .file))")
                                        .font(.caption.monospacedDigit())
                                        .foregroundStyle(.secondary)
                                }

                                Spacer()

                                ShareLink(item: clip.url) {
                                    Image(systemName: "square.and.arrow.up")
                                        .frame(width: 36, height: 36)
                                }
                                .buttonStyle(.plain)
                            }
                            .listRowBackground(cardDark)
                        }
                        .onDelete { offsets in
                            for idx in offsets {
                                recorder.deleteClip(recorder.savedClips[idx])
                            }
                        }
                    }
                    .scrollContentBackground(.hidden)
                    .background(bgDark.ignoresSafeArea())
                }
            }
            .navigationTitle("Saved Clips")
        }
    }

    // MARK: - Tab 3: Power & Buffer Settings

    private var powerTab: some View {
        NavigationStack {
            Form {
                Section("Circular Buffer Window") {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text("Buffer Length")
                            Spacer()
                            Text("\(recorder.bufferMinutes) min · \(String(format: "%.1f MB RAM", recorder.memoryMegabytes))")
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(.secondary)
                        }
                        Slider(
                            value: Binding(
                                get: { Double(recorder.bufferMinutes) },
                                set: { recorder.bufferMinutes = Int($0.rounded()) }
                            ),
                            in: 5...30,
                            step: 1
                        )
                        .tint(vermilion)
                    }

                    Picker("Sample Rate", selection: $recorder.sampleRateOption) {
                        ForEach(SampleRateOption.allCases) { opt in
                            Text(opt.label).tag(opt)
                        }
                    }
                }

                Section("24/7 Battery & Anti-Termination") {
                    Toggle("Low-Power 24/7 Mode", isOn: $recorder.lowPowerModeEnabled)
                    Toggle("Keep Screen Awake", isOn: $recorder.preventScreenSleep)

                    Picker("Auto-Checkpoint Backup", selection: $recorder.autoCheckpointMinutes) {
                        Text("Off").tag(0)
                        Text("Every 5 min").tag(5)
                        Text("Every 10 min").tag(10)
                        Text("Every 15 min").tag(15)
                    }

                    Button("Enter OLED Pocket Standby") {
                        oledStandby = true
                    }
                }

                Section("Live Device Health") {
                    LabeledContent("Background Audio Mode", value: "AVAudioSession Active")
                    LabeledContent("Thermal State", value: recorder.thermalStateLabel)
                    LabeledContent("iOS Low Power Mode", value: recorder.iosLowPowerActive ? "Active" : "Off")
                }

                Section {
                    Button("Clear Circular Buffer", role: .destructive) {
                        recorder.clearBuffer()
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(bgDark.ignoresSafeArea())
            .navigationTitle("Power & Buffer")
        }
    }

    // MARK: - Pure Black OLED Standby Overlay

    private var oledStandbyOverlay: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            VStack(spacing: 28) {
                Text("OLED STANDBY · BACKGROUND AUDIO ACTIVE")
                    .font(.caption2.monospaced())
                    .foregroundStyle(.gray.opacity(0.6))

                Spacer()

                Text(Date(), style: .time)
                    .font(.system(size: 56, weight: .medium, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.45))

                Text("Buffer \(AudioRecorderManager.formatTime(recorder.bufferedSeconds)) / \(AudioRecorderManager.formatTime(recorder.capacitySeconds))")
                    .font(.callout.monospacedDigit())
                    .foregroundStyle(vermilion.opacity(0.75))

                Spacer()

                VStack(spacing: 12) {
                    Button {
                        recorder.saveSegment(startAgoSec: 120, endAgoSec: 0)
                    } label: {
                        Text("Quick Save Last 2m")
                            .font(.subheadline.weight(.medium))
                            .frame(maxWidth: 260, minHeight: 50)
                            .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
                            .foregroundStyle(.white.opacity(0.75))
                    }

                    Button {
                        oledStandby = false
                    } label: {
                        Text("Wake Screen")
                            .font(.subheadline)
                            .frame(maxWidth: 260, minHeight: 48)
                            .foregroundStyle(.gray)
                    }
                }
            }
            .padding(32)
        }
    }
}
