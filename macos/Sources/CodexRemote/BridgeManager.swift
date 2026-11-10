import Foundation

@MainActor
protocol BridgeManaging: AnyObject {
    var isRunning: Bool { get }
    var bridgeDirectory: URL? { get }
    func locateBridge() -> URL?
    func start(port: Int, host: String, explicitNode: String?, onExit: @escaping (Int32) -> Void) throws
    func stop() async
    func stopNow()
    func logTail(maxLines: Int) -> String
}

extension BridgeManaging {
    func logTail() -> String { logTail(maxLines: 14) }
}

/// Owns the local `codex-remote` bridge process that the client can start for
/// the user. The bridge lives inside the app bundle so the client works from a
/// single .app without a separate checkout.
@MainActor
final class BridgeManager: BridgeManaging {
    enum BridgeError: LocalizedError {
        case notFound
        case noNode
        case logUnavailable(String)

        var errorDescription: String? {
            switch self {
            case .notFound:
                return "没有找到内置的 codex-remote 桥接文件。请用 scripts/build-macos.sh 重新构建 App。"
            case .noNode:
                return "没有找到 Node.js。可以在设置里指定 node 的路径，或安装 Node.js 后重试。"
            case .logUnavailable(let message):
                return "无法准备桥接日志：\(message)"
            }
        }
    }

    private(set) var process: Process?
    private(set) var bridgeDirectory: URL?
    private(set) var logURL: URL?
    private var logHandle: FileHandle?
    private var stopping = false
    private var onExit: ((Int32) -> Void)?

    var isRunning: Bool { process?.isRunning ?? false }

    /// Finds a directory containing `bin/codex-remote`. Inside the app bundle
    /// this is `Contents/Resources/bridge`; during `swift run` it falls back to
    /// the source checkout so development works without packaging first.
    func locateBridge() -> URL? {
        var candidates: [URL] = []
        if let resources = Bundle.main.resourceURL {
            candidates.append(resources.appendingPathComponent("bridge"))
        }
        if let configured = ProcessInfo.processInfo.environment["CODEX_REMOTE_BRIDGE_DIR"], !configured.isEmpty {
            candidates.append(URL(fileURLWithPath: configured, isDirectory: true))
        }
        let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
        candidates.append(cwd)
        candidates.append(cwd.deletingLastPathComponent())
        candidates.append(cwd.deletingLastPathComponent().deletingLastPathComponent())
        candidates.append(FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("codex-remote"))

        for directory in candidates {
            let script = directory.appendingPathComponent("bin/codex-remote")
            if FileManager.default.isExecutableFile(atPath: script.path) {
                bridgeDirectory = directory
                return directory
            }
        }
        return nil
    }

    static func findNode() -> String? {
        let environment = ProcessInfo.processInfo.environment
        if let configured = environment["CODEX_REMOTE_NODE"], FileManager.default.isExecutableFile(atPath: configured) {
            return configured
        }
        let home = FileManager.default.homeDirectoryForCurrentUser
        let fixed = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
            home.appendingPathComponent(".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node").path,
        ]
        for candidate in fixed where FileManager.default.isExecutableFile(atPath: candidate) {
            return candidate
        }

        // nvm keeps one directory per installed version; take the newest.
        let nvmRoot = home.appendingPathComponent(".nvm/versions/node", isDirectory: true)
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvmRoot.path) {
            for version in versions.sorted(by: { $0.localizedStandardCompare($1) == .orderedDescending }) {
                let node = nvmRoot.appendingPathComponent(version).appendingPathComponent("bin/node")
                if FileManager.default.isExecutableFile(atPath: node.path) {
                    return node.path
                }
            }
        }
        return nil
    }

    func start(port: Int, host: String, explicitNode: String?, onExit: @escaping (Int32) -> Void) throws {
        guard !isRunning else { return }
        guard let directory = bridgeDirectory ?? locateBridge() else {
            throw BridgeError.notFound
        }
        let script = directory.appendingPathComponent("bin/codex-remote")
        let node = explicitNode.flatMap { FileManager.default.isExecutableFile(atPath: $0) ? $0 : nil }
            ?? Self.findNode()
        guard let node else { throw BridgeError.noNode }

        let log = try prepareLogFile()
        let handle = try FileHandle(forWritingTo: log)
        try handle.seekToEnd()
        logHandle = handle
        logURL = log

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [script.path, "--port", String(port), "--host", host]
        process.currentDirectoryURL = directory
        var environment = ProcessInfo.processInfo.environment
        let nodeDirectory = URL(fileURLWithPath: node).deletingLastPathComponent().path
        let extraPath = [
            nodeDirectory,
            "/opt/homebrew/bin",
            "/usr/local/bin",
            FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex/bin").path,
            "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ]
        var seen = Set<String>()
        environment["PATH"] = extraPath.filter { seen.insert($0).inserted }.joined(separator: ":")
        environment["CODEX_REMOTE_NODE"] = node
        environment["HOME"] = FileManager.default.homeDirectoryForCurrentUser.path
        process.environment = environment
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = handle
        process.standardError = handle

        stopping = false
        self.onExit = onExit
        process.terminationHandler = { [weak self] finished in
            let status = finished.terminationStatus
            Task { @MainActor [weak self] in
                // An exit callback from a stopped process can arrive after its
                // replacement starts. Only clear the process that actually exited.
                guard let self, self.process === finished else { return }
                let intentional = self.stopping
                self.process = nil
                self.closeLog()
                if !intentional {
                    self.onExit?(status)
                }
            }
        }

        try process.run()
        self.process = process
    }

    /// Async stop used when switching ports or restarting from the UI.
    func stop() async {
        stopping = true
        guard let process else {
            closeLog()
            return
        }
        process.terminate()
        for _ in 0..<50 {
            if !process.isRunning { break }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        if process.isRunning {
            kill(process.processIdentifier, SIGKILL)
        }
        self.process = nil
        closeLog()
    }

    /// Synchronous stop for `applicationWillTerminate`, where we cannot await.
    func stopNow() {
        stopping = true
        guard let process else {
            closeLog()
            return
        }
        process.terminate()
        let deadline = Date().addingTimeInterval(1.2)
        while process.isRunning && Date() < deadline {
            usleep(50_000)
        }
        if process.isRunning {
            kill(process.processIdentifier, SIGKILL)
        }
        self.process = nil
        closeLog()
    }

    func logTail(maxLines: Int = 14) -> String {
        let url = logURL ?? expectedLogURL()
        guard let text = try? String(contentsOf: url, encoding: .utf8), !text.isEmpty else {
            return ""
        }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        return lines.suffix(maxLines).joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func expectedLogURL() -> URL {
        let base = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/CodexRemote", isDirectory: true)
        return base.appendingPathComponent("bridge.log")
    }

    private func expectedLogURL() -> URL {
        Self.expectedLogURL()
    }

    private func prepareLogFile() throws -> URL {
        let url = Self.expectedLogURL()
        let directory = url.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            if let size = try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber,
               size.intValue > 1_000_000 {
                try? FileManager.default.removeItem(at: url)
            }
            if !FileManager.default.fileExists(atPath: url.path) {
                FileManager.default.createFile(atPath: url.path, contents: nil)
            }
        } catch {
            throw BridgeError.logUnavailable(error.localizedDescription)
        }
        return url
    }

    private func closeLog() {
        try? logHandle?.close()
        logHandle = nil
    }
}
