import AppKit
import Foundation

/// Development-only flags. Nothing here is reachable from the normal UI.
enum DemoMode {
    static var isActive = false
}

@MainActor
enum WindowCapture {
    private static var requestedPath: String?

    static func request(_ path: String) {
        requestedPath = path
    }

    static func scheduleIfRequested() {
        guard let path = requestedPath else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) {
            capture(to: path)
        }
    }

    private static func capture(to path: String) {
        guard let window = NSApp.windows.first(where: { $0.isVisible && $0.contentView != nil && $0.contentView?.bounds.width ?? 0 > 400 }) else {
            FileHandle.standardError.write(Data("no window to capture\n".utf8))
            NSApp.terminate(nil)
            return
        }
        window.displayIfNeeded()
        guard let view = window.contentView else {
            NSApp.terminate(nil)
            return
        }
        let bounds = view.bounds
        guard let representation = view.bitmapImageRepForCachingDisplay(in: bounds) else {
            FileHandle.standardError.write(Data("could not create bitmap\n".utf8))
            NSApp.terminate(nil)
            return
        }
        view.cacheDisplay(in: bounds, to: representation)
        if let png = representation.representation(using: .png, properties: [:]) {
            do {
                try png.write(to: URL(fileURLWithPath: path))
                print(path)
            } catch {
                FileHandle.standardError.write(Data("could not write capture: \(error)\n".utf8))
            }
        }
        NSApp.terminate(nil)
    }
}
