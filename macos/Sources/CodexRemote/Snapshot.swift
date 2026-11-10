import AppKit
import SwiftUI

/// Development-only renderer used by `--render-snapshot`. It lets the project
/// produce a real preview of the native dashboard without opening a window.
@MainActor
enum SnapshotRenderer {
    static func render(to path: String) {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)

        let model = AppModel()
        model.loadDemoState()

        let content = DashboardView(autoBootstrap: false, scrollable: false)
            .environmentObject(model)
            .frame(width: 1040, height: 1120)
            .background(Color(nsColor: .windowBackgroundColor))

        let renderer = ImageRenderer(content: content)
        renderer.scale = 2
        renderer.isOpaque = true
        guard let image = renderer.nsImage,
              let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff),
              let png = bitmap.representation(using: .png, properties: [:])
        else {
            FileHandle.standardError.write(Data("could not render snapshot\n".utf8))
            return
        }
        do {
            try png.write(to: URL(fileURLWithPath: path))
            print(path)
        } catch {
            FileHandle.standardError.write(Data("could not write snapshot: \(error)\n".utf8))
        }
    }
}
