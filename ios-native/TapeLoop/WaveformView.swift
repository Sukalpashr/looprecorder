import SwiftUI

struct WaveformView: View {
    let peaks: [Float]
    let bufferedSeconds: Double
    let windowSeconds: Double
    let isRecording: Bool
    @Binding var trimMode: Bool
    @Binding var startAgoSec: Double
    @Binding var endAgoSec: Double

    private let vermilion = Color(red: 1.0, green: 59.0 / 255.0, blue: 48.0 / 255.0)

    var body: some View {
        GeometryReader { geo in
            let width = max(1, geo.size.width)
            let height = max(1, geo.size.height)

            ZStack(alignment: .leading) {
                Canvas { context, size in
                    let padV: CGFloat = 20
                    let waveH = size.height - padV * 2
                    let midY = size.height / 2

                    // Baseline
                    var baseline = Path()
                    baseline.move(to: CGPoint(x: 0, y: midY))
                    baseline.addLine(to: CGPoint(x: size.width, y: midY))
                    context.stroke(baseline, with: .color(.white.opacity(0.08)), lineWidth: 1)

                    // Active trim selection background
                    if trimMode {
                        let xStart = size.width * (1.0 - min(1.0, startAgoSec / max(1, windowSeconds)))
                        let xEnd = size.width * (1.0 - min(1.0, endAgoSec / max(1, windowSeconds)))
                        let selRect = CGRect(
                            x: min(xStart, xEnd),
                            y: padV,
                            width: max(2, abs(xEnd - xStart)),
                            height: waveH
                        )
                        context.fill(Path(selRect), with: .color(vermilion.opacity(0.16)))
                    }

                    // Waveform bars
                    let count = max(1, peaks.count)
                    let pitch = size.width / CGFloat(count)
                    let barW = max(1.8, pitch * 0.62)
                    let bufferedRatio = min(1.0, bufferedSeconds / max(1, windowSeconds))
                    let activeStartX = size.width * (1.0 - bufferedRatio)

                    for i in 0..<count {
                        let x = CGFloat(i) * pitch
                        let agoAtBar = windowSeconds * (1.0 - Double(x / size.width))
                        let inBuffer = x >= activeStartX - 2
                        if !inBuffer {
                            let dot = CGRect(x: x, y: midY - 1, width: barW, height: 2)
                            context.fill(Path(dot), with: .color(.white.opacity(0.09)))
                            continue
                        }

                        let raw = Double(peaks[i])
                        let boosted = pow(min(1.0, raw * 1.45), 0.72)
                        let halfH = max(2.0, CGFloat(boosted) * (waveH * 0.48))

                        let inSelection = trimMode && agoAtBar <= startAgoSec && agoAtBar >= endAgoSec
                        let barColor: Color = inSelection
                            ? vermilion
                            : (raw > 0.72 ? .orange : .white.opacity(0.84))

                        let rect = CGRect(x: x, y: midY - halfH, width: barW, height: halfH * 2)
                        context.fill(Path(rect), with: .color(barColor))
                    }

                    // Right-edge live playhead needle
                    let needle = CGRect(x: size.width - 2, y: padV - 6, width: 2, height: waveH + 12)
                    context.fill(Path(needle), with: .color(isRecording ? vermilion : .gray))
                }
                .background(Color(red: 17 / 255, green: 19 / 255, blue: 24 / 255))
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(Color.white.opacity(0.12), lineWidth: 1)
                )

                // Draggable Start & End Trim Handles
                if trimMode && bufferedSeconds >= 1 {
                    let maxAgo = max(1, min(windowSeconds, bufferedSeconds))
                    let startX = width * (1.0 - min(1.0, startAgoSec / max(1, windowSeconds)))
                    let endX = width * (1.0 - min(1.0, endAgoSec / max(1, windowSeconds)))

                    trimHandle(color: vermilion)
                        .position(x: max(12, min(width - 12, startX)), y: height / 2)
                        .gesture(
                            DragGesture()
                                .onChanged { val in
                                    let ratio = max(0, min(1, val.location.x / width))
                                    let ago = windowSeconds * (1.0 - ratio)
                                    startAgoSec = max(endAgoSec + 1, min(maxAgo, ago))
                                }
                        )

                    trimHandle(color: vermilion)
                        .position(x: max(12, min(width - 12, endX)), y: height / 2)
                        .gesture(
                            DragGesture()
                                .onChanged { val in
                                    let ratio = max(0, min(1, val.location.x / width))
                                    let ago = windowSeconds * (1.0 - ratio)
                                    endAgoSec = min(startAgoSec - 1, max(0, ago))
                                }
                        )
                }
            }
        }
        .frame(height: 196)
    }

    private func trimHandle(color: Color) -> some View {
        ZStack {
            Rectangle()
                .fill(color)
                .frame(width: 2, height: 156)
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .fill(color)
                .frame(width: 16, height: 36)
                .overlay(
                    RoundedRectangle(cornerRadius: 1)
                        .fill(.white.opacity(0.9))
                        .frame(width: 2, height: 16)
                )
        }
        .frame(width: 44, height: 180)
        .contentShape(Rectangle())
    }
}
