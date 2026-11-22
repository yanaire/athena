// SPDX-License-Identifier: Apache-2.0
// Offline artwork export using macOS AppKit, ImageIO and CoreGraphics only.
import AppKit
import CoreGraphics
import Foundation

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let output = CommandLine.arguments.count > 1
    ? URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true) : root
let ui = "athena-backend-handoff/athena-codex-ui/assets/"
let source = root.appendingPathComponent("assets/icon.svg")
guard let image = NSImage(contentsOf: source) else { fatalError("Cannot decode original SVG") }

func png(_ size: Int, _ relativePath: String) throws {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    bitmap.size = NSSize(width: size, height: size)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    NSGraphicsContext.current!.imageInterpolation = .high
    image.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
    NSGraphicsContext.restoreGraphicsState()
    let url = output.appendingPathComponent(relativePath)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
        withIntermediateDirectories: true)
    try bitmap.representation(using: .png, properties: [:])!.write(to: url)
}

try png(32, ui + "athena-icon-32.png")
try png(128, ui + "athena-icon-128.png")
try png(1024, "src-tauri/icons/icon.png")
let iconset = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".iconset")
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: iconset) }
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let name = "icon_\(size)x\(size)\(scale == 2 ? "@2x" : "").png"
        let relative = "src-tauri/icons/icon.png"
        try png(size * scale, relative)
        try FileManager.default.copyItem(at: output.appendingPathComponent(relative),
            to: iconset.appendingPathComponent(name))
    }
}
try png(1024, "src-tauri/icons/icon.png")
let process = Process()
process.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
process.arguments = ["-c", "icns", iconset.path, "-o",
    output.appendingPathComponent("src-tauri/icons/icon.icns").path]
try process.run()
process.waitUntilExit()
precondition(process.terminationStatus == 0, "iconutil export failed")
print("Exported 32/128/1024 PNGs and ten-frame desktop ICNS from assets/icon.svg")

// Three pages preserve the sample viewer's existing page contract.
// All wording and rules below are newly written for this replacement fixture.
let pages: [(String, [String])] = [
    ("Model and assumptions", [
        "Synthetic RC low-pass example / 1 of 3",
        "This fixture contains calculated values only. It is not an external paper,",
        "a measurement record, or a clinical result.",
        "",
        "R = 1000 ohms. C = 100 nanofarads. Output is across the capacitor.",
        "The source is ideal and the load has infinite impedance.",
        "H(jw) = 1 / (1 + jwRC)",
        "Gain in dB = -10 log10(1 + (2 pi f R C)^2)",
        "Cutoff in Hz = 1 / (2 pi R C)",
        "",
        "Loading, parasitics, temperature and noise are outside this model."
    ]),
    ("Calculated response", [
        "Synthetic RC low-pass example / 2 of 3",
        "Nominal cutoff: 1591.549 Hz.",
        "Gain at nominal cutoff: -3.0103 dB.",
        "",
        "For resistor limits of +/-1% and capacitor limits of +/-5%,",
        "the cutoff bounds are 1500.754 Hz and 1692.238 Hz.",
        "These are deterministic component bounds, not confidence intervals.",
        "",
        "A higher product R C produces a lower cutoff frequency.",
        "No physical instrument or external service produced these values."
    ]),
    ("Reproduction and scope", [
        "Synthetic RC low-pass example / 3 of 3",
        "Recalculate the cutoff with 1 / (2 * pi * 1000 * 100e-9).",
        "At the cutoff, the squared magnitude is 1/2.",
        "The gain is therefore -10 * log10(2) dB.",
        "",
        "This PDF was newly typeset by assets/render-artwork.swift.",
        "Its layout contains plain text and geometric rules only.",
        "The artwork and fixture sources use Apache-2.0; see root LICENSE.",
        "",
        "Keep actual observations separate from this synthetic demonstration."
    ])
]
let pdfURL = output.appendingPathComponent(ui + "sample-research-note.pdf")
// Standard PDF Helvetica is a viewer-supplied font, with no font program bundled.
// Write the small ASCII fixture directly to avoid OS font embedding and timestamps.
func literal(_ value: String) -> String {
    value.replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "(", with: "\\(")
        .replacingOccurrences(of: ")", with: "\\)")
}
var objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R] /Count 3 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
]
for (index, page) in pages.enumerated() {
    let (title, lines) = page
    let streamID = 5 + index * 2
    objects.append("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        + "/Resources << /Font << /F1 3 0 R >> >> /Contents \(streamID) 0 R >>")
    var stream = "0.15 0.24 0.26 rg 48 712 516 4 re f\n0 0 0 rg\n"
    stream += "BT /F1 22 Tf 48 738 Td (\(literal(title))) Tj ET\n"
    for (index, line) in lines.enumerated() {
        stream += "BT /F1 12 Tf 48 \(674 - index * 25) Td (\(literal(line))) Tj ET\n"
    }
    objects.append("<< /Length \(stream.utf8.count) >>\nstream\n\(stream)endstream")
}
var pdf = "%PDF-1.4\n"
var offsets = [0]
for (index, object) in objects.enumerated() {
    offsets.append(pdf.utf8.count)
    pdf += "\(index + 1) 0 obj\n\(object)\nendobj\n"
}
let xref = pdf.utf8.count
pdf += "xref\n0 \(objects.count + 1)\n0000000000 65535 f\r\n"
for offset in offsets.dropFirst() {
    pdf += String(format: "%010d 00000 n\r\n", offset)
}
pdf += "trailer\n<< /Size \(objects.count + 1) /Root 1 0 R >>\nstartxref\n\(xref)\n%%EOF\n"
try Data(pdf.utf8).write(to: pdfURL)
print("Exported independent three-page synthetic PDF fixture")
