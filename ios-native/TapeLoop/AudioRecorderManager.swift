import AVFoundation
import Combine
import Foundation
import UIKit

enum SampleRateOption: Double, CaseIterable, Identifiable {
    case voice16k = 16000
    case balanced22k = 22050
    case studio44k = 44100

    var id: Double { rawValue }

    var label: String {
        switch self {
        case .voice16k: return "Voice 24/7 (16 kHz)"
        case .balanced22k: return "Balanced (22.05 kHz)"
        case .studio44k: return "Studio Ambient (44.1 kHz)"
        }
    }

    var shortLabel: String {
        switch self {
        case .voice16k: return "16 kHz"
        case .balanced22k: return "22 kHz"
        case .studio44k: return "44.1 kHz"
        }
    }
}

struct SavedAudioClip: Identifiable, Hashable {
    let id: String
    let url: URL
    let title: String
    let createdAt: Date
    let durationSec: Double
    let sizeBytes: Int64
}

@MainActor
final class AudioRecorderManager: NSObject, ObservableObject, AVAudioPlayerDelegate {
    @Published var isRecording: Bool = false
    @Published var isPaused: Bool = false
    @Published var errorMessage: String?

    @Published var bufferMinutes: Int = 15 {
        didSet { applyBufferConfig() }
    }
    @Published var sampleRateOption: SampleRateOption = .voice16k {
        didSet { applyBufferConfig() }
    }
    @Published var lowPowerModeEnabled: Bool = false {
        didSet { applyPowerOptimizations() }
    }
    @Published var preventScreenSleep: Bool = true {
        didSet { updateIdleTimer() }
    }
    @Published var autoCheckpointMinutes: Int = 5 {
        didSet { rescheduleCheckpointTimer() }
    }

    @Published var bufferedSeconds: Double = 0
    @Published var capacitySeconds: Double = 900
    @Published var currentDb: Float = -60
    @Published var waveformPeaks: [Float] = Array(repeating: 0, count: 96)
    @Published var windowSeconds: Double = 300

    @Published var thermalStateLabel: String = "Nominal"
    @Published var iosLowPowerActive: Bool = ProcessInfo.processInfo.isLowPowerModeEnabled
    @Published var savedClips: [SavedAudioClip] = []
    @Published var playingClipID: String?
    @Published var statusToast: String?

    private let ringBuffer = CircularAudioBuffer(bufferMinutes: 15, sampleRate: 16000)
    private var engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private var targetFormat: AVAudioFormat?
    private var audioPlayer: AVAudioPlayer?

    private var uiTimer: Timer?
    private var checkpointTimer: Timer?
    private var latestDbBox = AtomicFloat(-60.0)
    private var isEngineRunningBeforeInterruption = false

    private var clipsDirectory: URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let dir = docs.appendingPathComponent("Clips", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    override init() {
        super.init()
        capacitySeconds = ringBuffer.capacitySeconds
        registerSystemObservers()
        refreshSavedClips()
        startUITimer()
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    var memoryMegabytes: Double {
        Double(ringBuffer.memoryBytes) / (1024.0 * 1024.0)
    }

    // MARK: - Recording Lifecycle

    func startLoop() {
        errorMessage = nil
        if #available(iOS 17.0, *) {
            AVAudioApplication.requestRecordPermission { [weak self] granted in
                Task { @MainActor in
                    guard let self else { return }
                    if !granted {
                        self.errorMessage = "Microphone permission is required in iOS Settings -> Privacy -> Microphone."
                        return
                    }
                    self.beginEngineCapture()
                }
            }
        } else {
            AVAudioSession.sharedInstance().requestRecordPermission { [weak self] granted in
                Task { @MainActor in
                    guard let self else { return }
                    if !granted {
                        self.errorMessage = "Microphone permission is required in iOS Settings -> Privacy -> Microphone."
                        return
                    }
                    self.beginEngineCapture()
                }
            }
        }
    }

    private func beginEngineCapture() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(
                .playAndRecord,
                mode: .measurement,
                options: [.mixWithOthers, .defaultToSpeaker, .allowBluetooth]
            )
            // Larger 50ms IO buffer minimizes CPU wakeups for 24/7 battery optimization
            try session.setPreferredIOBufferDuration(lowPowerModeEnabled ? 0.09 : 0.05)
            try session.setPreferredSampleRate(sampleRateOption.rawValue)
            try session.setActive(true, options: [])

            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
            engine = AVAudioEngine()

            let inputNode = engine.inputNode
            let inputFormat = inputNode.outputFormat(forBus: 0)
            guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
                errorMessage = "No active audio input route available."
                return
            }

            guard let outFmt = AVAudioFormat(
                commonFormat: .pcmFormatInt16,
                sampleRate: sampleRateOption.rawValue,
                channels: 1,
                interleaved: true
            ) else {
                errorMessage = "Failed to initialize target PCM format."
                return
            }

            targetFormat = outFmt
            converter = AVAudioConverter(from: inputFormat, to: outFmt)
            let localRing = ringBuffer
            let localConverter = converter
            let localDbBox = latestDbBox
            let bufferFrames: AVAudioFrameCount = lowPowerModeEnabled ? 4096 : 2048

            inputNode.installTap(onBus: 0, bufferSize: bufferFrames, format: inputFormat) { buffer, _ in
                guard let localConverter else { return }
                let ratio = outFmt.sampleRate / inputFormat.sampleRate
                let outCapacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
                guard let outBuffer = AVAudioPCMBuffer(pcmFormat: outFmt, frameCapacity: outCapacity) else { return }

                var consumed = false
                var convError: NSError?
                let status = localConverter.convert(to: outBuffer, error: &convError) { _, outStatus in
                    if consumed {
                        outStatus.pointee = .noDataNow
                        return nil
                    }
                    consumed = true
                    outStatus.pointee = .haveData
                    return buffer
                }

                if status != .error, let int16Ptr = outBuffer.int16ChannelData?[0], outBuffer.frameLength > 0 {
                    let slice = UnsafeBufferPointer(start: int16Ptr, count: Int(outBuffer.frameLength))
                    let db = localRing.append(samples: slice)
                    localDbBox.store(db)
                }
            }

            engine.prepare()
            try engine.start()
            isRecording = true
            isPaused = false
            updateIdleTimer()
            rescheduleCheckpointTimer()
        } catch {
            errorMessage = "Audio engine failed to start: \(error.localizedDescription)"
            isRecording = false
        }
    }

    func togglePause() {
        if isRecording {
            engine.pause()
            isRecording = false
            isPaused = true
            latestDbBox.store(-60)
            updateIdleTimer()
        } else if isPaused {
            do {
                try engine.start()
                isRecording = true
                isPaused = false
                updateIdleTimer()
            } catch {
                beginEngineCapture()
            }
        } else {
            startLoop()
        }
    }

    func stopLoop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        isRecording = false
        isPaused = false
        latestDbBox.store(-60)
        checkpointTimer?.invalidate()
        checkpointTimer = nil
        updateIdleTimer()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    func clearBuffer() {
        ringBuffer.clear()
        bufferedSeconds = 0
        waveformPeaks = Array(repeating: 0, count: 96)
        showToast("Circular buffer cleared")
    }

    // MARK: - Segment Saving to Device Storage (Files App)

    func saveSegment(startAgoSec: Double, endAgoSec: Double = 0, customTitle: String? = nil, isCheckpoint: Bool = false) {
        let extracted = ringBuffer.extractSegment(startAgoSec: startAgoSec, endAgoSec: endAgoSec)
        guard !extracted.samples.isEmpty, extracted.duration >= 0.25 else {
            if !isCheckpoint { showToast("Not enough audio buffered yet") }
            return
        }

        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        let stamp = formatter.string(from: Date())
        let filename = isCheckpoint
            ? "AutoCheckpoint-Latest.wav"
            : "\(customTitle ?? "TapeLoop-\(stamp)").wav"
        let destURL = clipsDirectory.appendingPathComponent(filename)

        let samples = extracted.samples
        let sr = extracted.sampleRate
        let duration = extracted.duration

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            do {
                try CircularAudioBuffer.writeWav(samples: samples, sampleRate: sr, to: destURL)
                Task { @MainActor in
                    guard let self else { return }
                    self.refreshSavedClips()
                    if !isCheckpoint {
                        self.showToast("Saved \(Self.formatTime(duration)) to Files")
                    }
                }
            } catch {
                Task { @MainActor in
                    self?.showToast("Save failed: \(error.localizedDescription)")
                }
            }
        }
    }

    func refreshSavedClips() {
        let fm = FileManager.default
        guard let urls = try? fm.contentsOfDirectory(
            at: clipsDirectory,
            includingPropertiesForKeys: [.creationDateKey, .fileSizeKey],
            options: [.skipsHiddenFiles]
        ) else {
            savedClips = []
            return
        }

        let clips: [SavedAudioClip] = urls
            .filter { $0.pathExtension.lowercased() == "wav" }
            .compactMap { url in
                let values = try? url.resourceValues(forKeys: [.creationDateKey, .fileSizeKey])
                let size = Int64(values?.fileSize ?? 0)
                let created = values?.creationDate ?? Date()
                let asset = try? AVAudioFile(forReading: url)
                let duration = asset.map { Double($0.length) / $0.fileFormat.sampleRate } ?? 0
                return SavedAudioClip(
                    id: url.lastPathComponent,
                    url: url,
                    title: url.deletingPathExtension().lastPathComponent,
                    createdAt: created,
                    durationSec: duration,
                    sizeBytes: size
                )
            }
            .sorted { $0.createdAt > $1.createdAt }

        savedClips = clips
    }

    func togglePlayback(clip: SavedAudioClip) {
        if playingClipID == clip.id {
            audioPlayer?.stop()
            playingClipID = nil
            return
        }
        do {
            audioPlayer?.stop()
            let player = try AVAudioPlayer(contentsOf: clip.url)
            player.delegate = self
            player.play()
            audioPlayer = player
            playingClipID = clip.id
        } catch {
            showToast("Unable to play clip")
        }
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            self.playingClipID = nil
        }
    }

    func deleteClip(_ clip: SavedAudioClip) {
        if playingClipID == clip.id {
            audioPlayer?.stop()
            playingClipID = nil
        }
        try? FileManager.default.removeItem(at: clip.url)
        refreshSavedClips()
    }

    // MARK: - Power, Thermal & iOS Continuity Safeguards

    private func applyBufferConfig() {
        let wasRunning = isRecording
        if wasRunning {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        ringBuffer.reconfigure(bufferMinutes: bufferMinutes, sampleRate: sampleRateOption.rawValue)
        capacitySeconds = ringBuffer.capacitySeconds
        windowSeconds = min(windowSeconds, capacitySeconds)
        if wasRunning {
            beginEngineCapture()
        }
    }

    private func applyPowerOptimizations() {
        if lowPowerModeEnabled {
            sampleRateOption = .voice16k
        }
        startUITimer()
        if isRecording {
            beginEngineCapture()
        }
    }

    private func updateIdleTimer() {
        UIApplication.shared.isIdleTimerDisabled = isRecording && preventScreenSleep
    }

    private func startUITimer() {
        uiTimer?.invalidate()
        let thermal = ProcessInfo.processInfo.thermalState
        let interval: TimeInterval
        if thermal == .serious || thermal == .critical {
            interval = 0.5 // 2 fps thermal throttle
        } else if lowPowerModeEnabled || iosLowPowerActive {
            interval = 0.15 // ~7 fps low-power throttle
        } else {
            interval = 0.05 // 20 fps smooth native refresh
        }

        uiTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                let snap = self.ringBuffer.snapshotPeaks(windowSeconds: self.windowSeconds, barCount: 96)
                self.waveformPeaks = snap.peaks
                self.bufferedSeconds = snap.bufferedSec
                self.capacitySeconds = snap.capacitySec
                self.currentDb = self.isRecording ? self.latestDbBox.load() : -60.0
            }
        }
    }

    private func rescheduleCheckpointTimer() {
        checkpointTimer?.invalidate()
        checkpointTimer = nil
        guard autoCheckpointMinutes > 0, isRecording else { return }
        let sec = Double(autoCheckpointMinutes * 60)
        checkpointTimer = Timer.scheduledTimer(withTimeInterval: sec, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.isRecording, self.bufferedSeconds >= 20 else { return }
                self.saveSegment(startAgoSec: min(self.bufferedSeconds, sec), endAgoSec: 0, isCheckpoint: true)
            }
        }
    }

    private func registerSystemObservers() {
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(handleInterruption(_:)), name: AVAudioSession.interruptionNotification, object: nil)
        nc.addObserver(self, selector: #selector(handleRouteChange(_:)), name: AVAudioSession.routeChangeNotification, object: nil)
        nc.addObserver(self, selector: #selector(handleMediaReset(_:)), name: AVAudioSession.mediaServicesWereResetNotification, object: nil)
        nc.addObserver(self, selector: #selector(handlePowerOrThermalChange), name: ProcessInfo.thermalStateDidChangeNotification, object: nil)
        nc.addObserver(self, selector: #selector(handlePowerOrThermalChange), name: .NSProcessInfoPowerStateDidChange, object: nil)
        updateThermalLabel()
    }

    @objc nonisolated private func handleInterruption(_ notification: Notification) {
        let typeRaw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
        Task { @MainActor in
            guard let typeRaw,
                  let type = AVAudioSession.InterruptionType(rawValue: typeRaw) else { return }

            if type == .began {
                self.isEngineRunningBeforeInterruption = self.isRecording
                self.engine.pause()
                self.isRecording = false
                self.isPaused = true
            } else if type == .ended, self.isEngineRunningBeforeInterruption {
                // Automatically resume 24/7 capture after phone call / Siri ends
                self.beginEngineCapture()
            }
        }
    }

    @objc nonisolated private func handleRouteChange(_ notification: Notification) {
        Task { @MainActor in
            guard self.isRecording else { return }
            // Reattach tap seamlessly when AirPods / headset connects or disconnects
            self.beginEngineCapture()
        }
    }

    @objc nonisolated private func handleMediaReset(_ notification: Notification) {
        Task { @MainActor in
            guard self.isRecording else { return }
            self.beginEngineCapture()
        }
    }

    @objc nonisolated private func handlePowerOrThermalChange() {
        Task { @MainActor in
            self.iosLowPowerActive = ProcessInfo.processInfo.isLowPowerModeEnabled
            self.updateThermalLabel()
            self.startUITimer()
        }
    }

    private func updateThermalLabel() {
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: thermalStateLabel = "Nominal"
        case .fair: thermalStateLabel = "Fair"
        case .serious: thermalStateLabel = "Serious (Throttled)"
        case .critical: thermalStateLabel = "Critical (Throttled)"
        @unknown default: thermalStateLabel = "Nominal"
        }
    }

    private func showToast(_ text: String) {
        statusToast = text
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.8) { [weak self] in
            if self?.statusToast == text {
                self?.statusToast = nil
            }
        }
    }

    static func formatTime(_ seconds: Double) -> String {
        let s = max(0, Int(seconds))
        let mins = s / 60
        let rem = s % 60
        return String(format: "%02d:%02d", mins, rem)
    }
}

private final class AtomicFloat: @unchecked Sendable {
    private var lock = os_unfair_lock_s()
    private var value: Float

    init(_ initial: Float) { self.value = initial }

    func store(_ newValue: Float) {
        os_unfair_lock_lock(&lock)
        value = newValue
        os_unfair_lock_unlock(&lock)
    }

    func load() -> Float {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }
        return value
    }
}
