import Foundation
import os

/// Lock-protected, zero-allocation circular PCM ring buffer storing mono Int16 samples
/// and downsampled waveform peaks (10 peaks/sec) for 24/7 low-RAM iOS capture.
final class CircularAudioBuffer: @unchecked Sendable {
    private var lock = os_unfair_lock_s()
    private var pcmRing: [Int16]
    private var writeIndex: Int = 0
    private var totalWrittenSamples: Int64 = 0

    private let peaksPerSecond: Int = 10
    private var peakRing: [Float]
    private var peakWriteIndex: Int = 0
    private var totalWrittenPeaks: Int64 = 0
    private var peakSampleAccum: Int = 0
    private var currentPeakMax: Float = 0
    private var samplesPerPeak: Int

    private(set) var bufferMinutes: Int
    private(set) var sampleRate: Double

    init(bufferMinutes: Int = 15, sampleRate: Double = 16000) {
        self.bufferMinutes = max(5, min(30, bufferMinutes))
        self.sampleRate = sampleRate
        let totalSamples = Int(Double(self.bufferMinutes * 60) * sampleRate)
        self.pcmRing = [Int16](repeating: 0, count: max(1, totalSamples))
        self.samplesPerPeak = max(1, Int(sampleRate) / peaksPerSecond)
        self.peakRing = [Float](repeating: 0, count: max(1, self.bufferMinutes * 60 * peaksPerSecond))
    }

    var memoryBytes: Int {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }
        return pcmRing.count * MemoryLayout<Int16>.stride + peakRing.count * MemoryLayout<Float>.stride
    }

    var capacitySeconds: Double {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }
        return Double(pcmRing.count) / sampleRate
    }

    var bufferedSeconds: Double {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }
        let available = min(Int64(pcmRing.count), totalWrittenSamples)
        return Double(available) / sampleRate
    }

    /// Reconfigures buffer length (5–30 min) or sample rate while preserving the recent audio tail if sample rate is unchanged.
    func reconfigure(bufferMinutes newMinutes: Int, sampleRate newRate: Double) {
        let clamped = max(5, min(30, newMinutes))
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }

        if clamped == self.bufferMinutes && abs(newRate - self.sampleRate) < 1.0 {
            return
        }

        var preservedTail: [Int16] = []
        let oldAvailable = Int(min(Int64(pcmRing.count), totalWrittenSamples))
        if oldAvailable > 0 && abs(newRate - self.sampleRate) < 1.0 {
            let newCap = Int(Double(clamped * 60) * newRate)
            let keepCount = min(oldAvailable, newCap)
            preservedTail = readLastSamplesUnlocked(count: keepCount)
        }

        self.bufferMinutes = clamped
        self.sampleRate = newRate
        let totalSamples = Int(Double(clamped * 60) * newRate)
        self.pcmRing = [Int16](repeating: 0, count: max(1, totalSamples))
        self.samplesPerPeak = max(1, Int(newRate) / peaksPerSecond)
        self.peakRing = [Float](repeating: 0, count: max(1, clamped * 60 * peaksPerSecond))

        self.writeIndex = 0
        self.totalWrittenSamples = 0
        self.peakWriteIndex = 0
        self.totalWrittenPeaks = 0
        self.peakSampleAccum = 0
        self.currentPeakMax = 0

        if !preservedTail.isEmpty {
            preservedTail.withUnsafeBufferPointer { ptr in
                appendUnlocked(samples: ptr)
            }
        }
    }

    func clear() {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }
        pcmRing.withUnsafeMutableBufferPointer { $0.initialize(repeating: 0) }
        peakRing.withUnsafeMutableBufferPointer { $0.initialize(repeating: 0) }
        writeIndex = 0
        totalWrittenSamples = 0
        peakWriteIndex = 0
        totalWrittenPeaks = 0
        peakSampleAccum = 0
        currentPeakMax = 0
    }

    /// Realtime-safe append invoked on the AVAudioEngine tap thread. Returns RMS dB for metering.
    @discardableResult
    func append(samples: UnsafeBufferPointer<Int16>) -> Float {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }
        return appendUnlocked(samples: samples)
    }

    @discardableResult
    private func appendUnlocked(samples: UnsafeBufferPointer<Int16>) -> Float {
        let count = samples.count
        guard count > 0 else { return -60.0 }
        let ringLen = pcmRing.count
        let peakLen = peakRing.count

        var sumSq: Double = 0
        for i in 0..<count {
            let s = samples[i]
            pcmRing[writeIndex] = s
            writeIndex += 1
            if writeIndex >= ringLen { writeIndex = 0 }
            totalWrittenSamples += 1

            let norm = Float(s) / 32768.0
            sumSq += Double(norm * norm)

            let absNorm = abs(norm)
            if absNorm > currentPeakMax { currentPeakMax = absNorm }
            peakSampleAccum += 1
            if peakSampleAccum >= samplesPerPeak {
                peakRing[peakWriteIndex] = currentPeakMax
                peakWriteIndex += 1
                if peakWriteIndex >= peakLen { peakWriteIndex = 0 }
                totalWrittenPeaks += 1
                peakSampleAccum = 0
                currentPeakMax = 0
            }
        }

        let rms = sqrt(sumSq / Double(count))
        if rms <= 0.00001 { return -60.0 }
        return Float(max(-60.0, min(0.0, 20.0 * log10(rms))))
    }

    private func readLastSamplesUnlocked(count: Int) -> [Int16] {
        let ringLen = pcmRing.count
        let available = min(count, Int(min(Int64(ringLen), totalWrittenSamples)))
        guard available > 0 else { return [] }
        var out = [Int16](repeating: 0, count: available)
        let startIdx = (writeIndex - available + ringLen) % ringLen
        if startIdx + available <= ringLen {
            out.replaceSubrange(0..<available, with: pcmRing[startIdx..<(startIdx + available)])
        } else {
            let firstPart = ringLen - startIdx
            out.replaceSubrange(0..<firstPart, with: pcmRing[startIdx..<ringLen])
            out.replaceSubrange(firstPart..<available, with: pcmRing[0..<(available - firstPart)])
        }
        return out
    }

    /// Extracts an exact Int16 PCM slice measured backwards from "now" (e.g. startAgoSec=120, endAgoSec=0 => last 2 min).
    func extractSegment(startAgoSec: Double, endAgoSec: Double = 0) -> (samples: [Int16], sampleRate: Double, duration: Double) {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }

        let ringLen = pcmRing.count
        let availableSamples = Int(min(Int64(ringLen), totalWrittenSamples))
        let availableSec = Double(availableSamples) / sampleRate

        let clampedEnd = max(0, min(availableSec, endAgoSec))
        let clampedStart = max(clampedEnd, min(availableSec, startAgoSec))

        let endOffset = Int(clampedEnd * sampleRate)
        let startOffset = Int(clampedStart * sampleRate)
        let length = max(0, startOffset - endOffset)
        guard length > 0 else { return ([], sampleRate, 0) }

        var out = [Int16](repeating: 0, count: length)
        let startIdx = (writeIndex - startOffset + ringLen * 2) % ringLen
        if startIdx + length <= ringLen {
            out.replaceSubrange(0..<length, with: pcmRing[startIdx..<(startIdx + length)])
        } else {
            let firstPart = ringLen - startIdx
            out.replaceSubrange(0..<firstPart, with: pcmRing[startIdx..<ringLen])
            out.replaceSubrange(firstPart..<length, with: pcmRing[0..<(length - firstPart)])
        }

        return (out, sampleRate, Double(length) / sampleRate)
    }

    func snapshotPeaks(windowSeconds: Double, barCount: Int) -> (peaks: [Float], bufferedSec: Double, capacitySec: Double) {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }

        let capacitySec = Double(pcmRing.count) / sampleRate
        let bufferedSec = min(capacitySec, Double(totalWrittenSamples) / sampleRate)
        let effectiveWindow = max(10.0, min(capacitySec, windowSeconds))
        var out = [Float](repeating: 0, count: max(1, barCount))

        let totalPeaksInWindow = Double(effectiveWindow) * Double(peaksPerSecond)
        let availablePeaks = Int(min(Int64(peakRing.count), totalWrittenPeaks))
        let ringLen = peakRing.count
        let peaksPerBar = totalPeaksInWindow / Double(out.count)

        for b in 0..<out.count {
            let agoStart = Int(Double(out.count - b) * peaksPerBar)
            let agoEnd = Int(Double(out.count - 1 - b) * peaksPerBar)
            if agoEnd >= availablePeaks {
                out[b] = 0
                continue
            }
            let clampedStart = min(availablePeaks, max(agoEnd + 1, agoStart))
            var maxVal: Float = 0
            let step = max(1, (clampedStart - agoEnd) / 12)
            var ago = agoEnd
            while ago < clampedStart {
                let idx = (peakWriteIndex - 1 - ago + ringLen * 2) % ringLen
                let v = peakRing[idx]
                if v > maxVal { maxVal = v }
                ago += step
            }
            out[b] = maxVal
        }

        return (out, bufferedSec, capacitySec)
    }

    /// Writes mono 16-bit PCM samples as a standard WAV file to disk.
    static func writeWav(samples: [Int16], sampleRate: Double, to url: URL) throws {
        let dataSize = UInt32(samples.count * 2)
        let sr = UInt32(sampleRate)
        let byteRate = sr * 2
        var header = Data(capacity: 44 + Int(dataSize))

        header.append("RIFF".data(using: .ascii)!)
        header.append(littleEndian: UInt32(36 + dataSize))
        header.append("WAVE".data(using: .ascii)!)
        header.append("fmt ".data(using: .ascii)!)
        header.append(littleEndian: UInt32(16))
        header.append(littleEndian: UInt16(1)) // PCM
        header.append(littleEndian: UInt16(1)) // Mono
        header.append(littleEndian: sr)
        header.append(littleEndian: byteRate)
        header.append(littleEndian: UInt16(2)) // Block align
        header.append(littleEndian: UInt16(16)) // Bits per sample
        header.append("data".data(using: .ascii)!)
        header.append(littleEndian: dataSize)

        samples.withUnsafeBytes { rawBuf in
            header.append(contentsOf: rawBuf)
        }

        try header.write(to: url, options: .atomic)
    }
}

private extension Data {
    mutating func append<T: FixedWidthInteger>(littleEndian value: T) {
        var v = value.littleEndian
        Swift.withUnsafeBytes(of: &v) { append(contentsOf: $0) }
    }
}
