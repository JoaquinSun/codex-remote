import AppKit
import Foundation
import ServiceManagement
import SwiftUI

/// Owns the local `codex-remote` server: process lifecycle, live status, the
/// access URLs, and the settings that persist between launches.
@MainActor
final class AppModel: ObservableObject {
    enum Phase: Equatable {
        case stopped
        case starting
        case stopping
        case running
        case failed
    }

    struct ServerEndpoint: Identifiable, Hashable {
        enum Kind: Int, Comparable {
            case lan = 0
            case tailscale = 1
            case other = 2
            case local = 3

            static func < (lhs: Kind, rhs: Kind) -> Bool { lhs.rawValue < rhs.rawValue }
        }

        let id: String
        let title: String
        let detail: String
        let urlString: String
        let kind: Kind

        var isLocal: Bool { kind == .local }
        var systemImage: String {
            switch kind {
            case .lan: return "wifi"
            case .tailscale: return "globe.americas"
            case .other: return "network"
            case .local: return "laptopcomputer"
            }
        }
    }

    private struct BridgeMeta: Decodable {
        let name: String
        let hostname: String?
        let host: String?
        let listenHost: String?
        let version: String
        let startedAt: Double?
        let connected: Bool?
    }

    private struct BridgePing: Decodable {
        struct Daemon: Decodable {
            let ok: Bool?
            let ms: Double?
            let error: String?
            let busy: Bool?
        }

        let ok: Bool?
        let now: Double?
        let connected: Bool?
        let clients: Int?
        let daemon: Daemon?
        let serverMs: Double?
    }

    private enum ProbeResult {
        case live(BridgeMeta, BridgePing?)
        case unauthorized
        case otherService
        case unreachable
    }

    // MARK: - Published state

    @Published private(set) var phase: Phase = .stopped
    @Published private(set) var detail = "服务器未启动"
    @Published private(set) var ownsServer = false
    @Published private(set) var bridgeVersion = ""
    @Published private(set) var bridgeName = ""
    @Published private(set) var hostName = ""
    @Published private(set) var daemonConnected = false
    @Published private(set) var daemonLatency: Double?
    @Published private(set) var serverLatency: Double?
    @Published private(set) var clientCount = 0
    @Published private(set) var startedAt: Date?
    @Published private(set) var uptime: TimeInterval = 0
    @Published private(set) var endpoints: [ServerEndpoint] = []
    @Published private(set) var token = ""
    @Published private(set) var logTail = ""
    @Published private(set) var lastError: String?
    @Published private(set) var launchAtLogin = false
    @Published private(set) var loginItemError: String?
    @Published private(set) var activePort = 8787
    @Published private(set) var activeLAN = true
    @Published var revealToken = false
    @Published var settingsExpanded = false

    // MARK: - Settings

    @Published var port: Int {
        didSet {
            let clamped = min(max(port, 1024), 65535)
            if clamped != port {
                port = clamped
                return
            }
            guard oldValue != port else { return }
            defaults.set(port, forKey: Keys.port)
            refreshEndpoints()
        }
    }

    @Published var listenOnLAN: Bool {
        didSet {
            guard oldValue != listenOnLAN else { return }
            defaults.set(listenOnLAN, forKey: Keys.listenLAN)
            refreshEndpoints()
        }
    }

    @Published var autoStart: Bool {
        didSet {
            guard oldValue != autoStart else { return }
            defaults.set(autoStart, forKey: Keys.autoStart)
            if autoStart, started, phase == .stopped {
                Task { await startServer() }
            }
        }
    }

    @Published var keepAwake: Bool {
        didSet {
            guard oldValue != keepAwake else { return }
            defaults.set(keepAwake, forKey: Keys.keepAwake)
            refreshKeepAwake()
        }
    }

    @Published var stopOnQuit: Bool {
        didSet { defaults.set(stopOnQuit, forKey: Keys.stopOnQuit) }
    }

    @Published var nodePath: String {
        didSet { defaults.set(nodePath, forKey: Keys.nodePath) }
    }

    @Published var showInDock: Bool {
        didSet {
            guard oldValue != showInDock else { return }
            defaults.set(showInDock, forKey: Keys.showInDock)
            applyActivationPolicy()
        }
    }

    // MARK: - Dependencies

    let bridge: any BridgeManaging

    private let defaults: UserDefaults
    private let session: URLSession
    private let storageDirectory: URL
    private let networkInterfaces: () -> [Network.Interface]
    private var started = false
    private var terminating = false
    private var monitorTask: Task<Void, Never>?
    private var startTask: Task<Void, Never>?
    private var probeMisses = 0
    private var activityToken: NSObjectProtocol?

    private enum Keys {
        static let port = "CodexRemote.port"
        static let listenLAN = "CodexRemote.listenOnLAN"
        static let autoStart = "CodexRemote.autoStartServer"
        static let keepAwake = "CodexRemote.keepAwake"
        static let stopOnQuit = "CodexRemote.stopBridgeOnQuit"
        static let nodePath = "CodexRemote.nodePath"
        static let showInDock = "CodexRemote.showInDock"
    }

    init(
        bridge: (any BridgeManaging)? = nil,
        defaults: UserDefaults = .standard,
        session: URLSession = .shared,
        dataFolder: URL? = nil,
        networkInterfaces: @escaping () -> [Network.Interface] = Network.ipv4Interfaces
    ) {
        self.bridge = bridge ?? BridgeManager()
        self.defaults = defaults
        self.session = session
        storageDirectory = dataFolder ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".codex-remote", isDirectory: true)
        self.networkInterfaces = networkInterfaces
        port = defaults.object(forKey: Keys.port) as? Int ?? 8787
        listenOnLAN = defaults.object(forKey: Keys.listenLAN) as? Bool ?? true
        autoStart = defaults.object(forKey: Keys.autoStart) as? Bool ?? true
        keepAwake = defaults.object(forKey: Keys.keepAwake) as? Bool ?? false
        stopOnQuit = defaults.object(forKey: Keys.stopOnQuit) as? Bool ?? true
        nodePath = defaults.string(forKey: Keys.nodePath) ?? ""
        showInDock = defaults.object(forKey: Keys.showInDock) as? Bool ?? true
        activePort = port
        activeLAN = listenOnLAN

        refreshLaunchAtLogin()
        refreshEndpoints()

        NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.shutdown()
            }
        }
    }

    // MARK: - Computed

    var isRunning: Bool { phase == .running }
    var isBusy: Bool { phase == .starting || phase == .stopping }
    var canStop: Bool { phase == .running && ownsServer }
    var needsRestart: Bool {
        isRunning && (activePort != port || activeLAN != listenOnLAN)
    }

    var statusTitle: String {
        switch phase {
        case .stopped: return "已停止"
        case .starting: return "启动中"
        case .stopping: return "停止中"
        case .running: return "运行中"
        case .failed: return "启动失败"
        }
    }

    var statusSubtitle: String {
        switch phase {
        case .running:
            return ownsServer ? "由 Codex Remote 托管" : "由外部进程托管"
        case .starting, .stopping:
            return detail
        case .stopped:
            return "服务器未启动"
        case .failed:
            return "请查看错误详情"
        }
    }

    private var usesActiveListener: Bool { isRunning || isBusy || (ownsServer && bridge.isRunning) }
    private var listenerPort: Int { usesActiveListener ? activePort : port }
    private var listenerAllowsLAN: Bool { usesActiveListener ? activeLAN : listenOnLAN }
    var hostLabel: String { listenerAllowsLAN ? "局域网（0.0.0.0）" : "仅本机（127.0.0.1）" }
    var localAddress: String { "127.0.0.1:\(listenerPort)" }
    var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    }
    var detectedNode: String? { BridgeManager.findNode() }
    var dataFolder: URL {
        storageDirectory
    }
    var primaryEndpoint: ServerEndpoint? {
        endpoints.first(where: { $0.kind == .lan })
            ?? endpoints.first(where: { $0.kind == .tailscale })
            ?? endpoints.first
    }
    var primaryURLString: String? { primaryEndpoint?.urlString }

    var uptimeText: String {
        guard phase == .running else { return "—" }
        let total = Int(max(uptime, 0))
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let seconds = total % 60
        if hours > 0 { return "\(hours) 小时 \(minutes) 分" }
        if minutes > 0 { return "\(minutes) 分 \(seconds) 秒" }
        return "\(seconds) 秒"
    }

    var daemonLatencyText: String {
        guard daemonConnected else { return "—" }
        guard let daemonLatency, daemonLatency.isFinite else { return "…" }
        return "\(Int(daemonLatency.rounded())) ms"
    }

    var clientCountText: String { "\(clientCount)" }

    // MARK: - Lifecycle

    func bootstrap() {
        guard !started else { return }
        started = true
        if DemoMode.isActive {
            loadDemoState()
            return
        }
        applyActivationPolicy()
        refreshLaunchAtLogin()
        refreshEndpoints()
        refreshLogTail()
        startTask = Task { [weak self] in
            guard let self else { return }
            if await self.attachIfRunning() { return }
            if self.autoStart {
                await self.startServer()
            } else {
                self.setPhase(.stopped, "服务器未启动")
                self.refreshEndpoints()
            }
        }
    }

    func shutdown() {
        guard !terminating else { return }
        terminating = true
        monitorTask?.cancel()
        startTask?.cancel()
        endKeepAwake()
        if stopOnQuit && ownsServer {
            bridge.stopNow()
            ownsServer = false
        }
    }

    // MARK: - Start / stop

    @discardableResult
    private func attachIfRunning() async -> Bool {
        switch await probe() {
        case .live(let meta, let ping):
            applyLive(meta, ping, owns: false)
            return true
        case .unauthorized:
            setPhase(.failed, "服务器令牌不匹配")
            lastError = "端口 \(port) 上有服务回应，但 token 不匹配。\n请确认 ~/.codex-remote/token 可读。"
            return true
        case .otherService:
            setPhase(.failed, "端口已被占用")
            lastError = "端口 \(port) 已被其他服务占用，请换一个端口。"
            return true
        case .unreachable:
            return false
        }
    }

    func startServer() async {
        guard phase != .starting, phase != .stopping else { return }
        monitorTask?.cancel()
        probeMisses = 0
        lastError = nil
        activePort = port
        activeLAN = listenOnLAN
        setPhase(.starting, "正在检查端口…")
        refreshLogTail()

        switch await probe() {
        case .live(let meta, let ping):
            applyLive(meta, ping, owns: false)
            return
        case .unauthorized:
            setPhase(.failed, "服务器令牌不匹配")
            lastError = "端口 \(port) 上有服务回应，但 token 不匹配。\n请检查 ~/.codex-remote/token。"
            return
        case .otherService:
            setPhase(.failed, "端口已被占用")
            lastError = "端口 \(port) 已被其他服务占用，请换一个端口。"
            return
        case .unreachable:
            break
        }

        if bridge.isRunning {
            await bridge.stop()
            ownsServer = false
        }

        let host = activeLAN ? "0.0.0.0" : "127.0.0.1"
        setPhase(.starting, "正在启动内置桥接…")
        do {
            try bridge.start(port: activePort, host: host, explicitNode: nodePath) { [weak self] code in
                self?.bridgeExited(code)
            }
            ownsServer = true
        } catch {
            setPhase(.failed, "启动失败")
            lastError = error.localizedDescription
            return
        }

        for _ in 0..<80 {
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled else { return }
            switch await probe(includePing: false) {
            case .live(let meta, let ping):
                applyLive(meta, ping, owns: true)
                return
            case .unauthorized:
                if bridge.isRunning { await bridge.stop() }
                ownsServer = false
                setPhase(.failed, "令牌不可用")
                lastError = "服务器启动了，但读取不到有效的 token 文件。"
                return
            case .otherService:
                if bridge.isRunning { await bridge.stop() }
                ownsServer = false
                setPhase(.failed, "端口冲突")
                lastError = "端口 \(port) 已被其他服务占用。"
                return
            case .unreachable:
                continue
            }
        }

        var message = "服务器启动超时，端口 \(port) 一直没有响应。"
        let tail = bridge.logTail()
        if !tail.isEmpty { message += "\n\n最近日志：\n" + tail }
        if bridge.isRunning { await bridge.stop() }
        ownsServer = false
        setPhase(.failed, "启动超时")
        lastError = message
    }

    func stopServer() async {
        guard phase == .running else { return }
        guard ownsServer else {
            lastError = "这个服务不是由 Codex Remote 启动的（可能来自 launchd），请在对应的服务管理里停止。"
            return
        }
        monitorTask?.cancel()
        setPhase(.stopping, "正在停止服务器…")
        await bridge.stop()
        ownsServer = false
        startedAt = nil
        uptime = 0
        clientCount = 0
        daemonLatency = nil
        serverLatency = nil
        setPhase(.stopped, "服务器已停止")
        refreshEndpoints()
        refreshKeepAwake()
    }

    func restartServer() async {
        guard phase != .starting, phase != .stopping else { return }
        if !ownsServer && phase == .running {
            lastError = "这个服务由外部进程托管，Codex Remote 无法重启它。"
            return
        }
        monitorTask?.cancel()
        if ownsServer {
            setPhase(.stopping, "正在重启服务器…")
            await bridge.stop()
            ownsServer = false
        }
        startedAt = nil
        uptime = 0
        clientCount = 0
        daemonLatency = nil
        serverLatency = nil
        setPhase(.stopped, "正在重启服务器…")
        refreshKeepAwake()
        await startServer()
    }

    func toggleServer() {
        guard !isBusy else { return }
        if phase == .running {
            Task { await stopServer() }
        } else {
            Task { await startServer() }
        }
    }

    func reconnect() {
        startTask?.cancel()
        startTask = Task { [weak self] in
            guard let self else { return }
            if await self.attachIfRunning() { return }
            if self.phase == .running { return }
            if self.autoStart { await self.startServer() }
        }
    }

    // MARK: - Monitoring

    private func updateListener(from meta: BridgeMeta) {
        guard let host = meta.listenHost else { return }
        activeLAN = !host.hasPrefix("127.") && host != "::1" && host != "localhost"
    }

    private func applyLive(_ meta: BridgeMeta, _ ping: BridgePing?, owns: Bool) {
        ownsServer = owns
        bridgeVersion = meta.version
        bridgeName = meta.name
        hostName = meta.hostname ?? meta.host ?? ""
        daemonConnected = ping?.connected ?? meta.connected ?? false
        clientCount = ping?.clients ?? 0
        daemonLatency = ping?.daemon?.ms
        serverLatency = ping?.serverMs
        if let startedAt = meta.startedAt {
            self.startedAt = Date(timeIntervalSince1970: startedAt / 1000)
        }
        updateUptime()
        probeMisses = 0
        lastError = nil
        setPhase(.running, owns ? "服务器正在运行" : "已连接到正在运行的服务器")
        token = readToken() ?? token
        updateListener(from: meta)
        refreshEndpoints()
        refreshLogTail()
        refreshKeepAwake()
        startMonitor()
    }

    private func startMonitor() {
        monitorTask?.cancel()
        monitorTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_500_000_000)
                guard !Task.isCancelled, let self else { return }
                await self.refreshLiveStatus()
            }
        }
    }

    private func refreshLiveStatus() async {
        guard phase == .running else { return }
        let result = await probe()
        guard phase == .running, !Task.isCancelled else { return }
        switch result {
        case .live(let meta, let ping):
            probeMisses = 0
            bridgeVersion = meta.version
            bridgeName = meta.name
            hostName = meta.hostname ?? meta.host ?? hostName
            daemonConnected = ping?.connected ?? meta.connected ?? daemonConnected
            clientCount = ping?.clients ?? clientCount
            daemonLatency = ping?.daemon?.ms
            serverLatency = ping?.serverMs
            if let startedAt = meta.startedAt {
                self.startedAt = Date(timeIntervalSince1970: startedAt / 1000)
            }
            updateUptime()
            token = readToken() ?? token
            updateListener(from: meta)
            refreshEndpoints()
            refreshLogTail()
            if lastError != nil { lastError = nil }
        case .unauthorized:
            probeMisses += 1
            if probeMisses >= 2 {
                lastError = "服务器仍在运行，但 token 校验失败。请检查 ~/.codex-remote/token。"
            }
        case .otherService:
            probeMisses += 1
            if probeMisses >= 2 {
                monitorTask?.cancel()
                ownsServer = false
                setPhase(.failed, "端口被占用")
                lastError = "端口 \(activePort) 现在被其他服务占用，Codex Remote 服务器可能已经退出。"
                refreshKeepAwake()
            }
        case .unreachable:
            probeMisses += 1
            if ownsServer {
                if !bridge.isRunning {
                    monitorTask?.cancel()
                    ownsServer = false
                    setPhase(.failed, "服务器进程已退出")
                    lastError = "内置桥接进程已经退出。"
                    refreshKeepAwake()
                } else if probeMisses >= 4 {
                    monitorTask?.cancel()
                    setPhase(.failed, "服务器无响应")
                    lastError = "桥接进程还在运行，但端口 \(activePort) 没有响应。"
                    refreshKeepAwake()
                }
            } else if probeMisses >= 2 {
                monitorTask?.cancel()
                ownsServer = false
                startedAt = nil
                uptime = 0
                clientCount = 0
                setPhase(.stopped, "服务器已停止")
                refreshEndpoints()
                refreshKeepAwake()
            }
        }
    }

    private func bridgeExited(_ code: Int32) {
        guard !terminating, ownsServer else { return }
        monitorTask?.cancel()
        ownsServer = false
        var message = "内置服务器已经退出（状态码 \(code)）。"
        let tail = bridge.logTail()
        if !tail.isEmpty { message += "\n\n最近日志：\n" + tail }
        setPhase(.failed, "服务器已退出")
        lastError = message
        refreshKeepAwake()
    }

    private func updateUptime() {
        guard let startedAt else {
            uptime = 0
            return
        }
        uptime = max(0, Date().timeIntervalSince(startedAt))
    }

    // MARK: - HTTP

    private func probe(includePing: Bool = true) async -> ProbeResult {
        guard let metaURL = apiURL(path: "/api/meta") else { return .unreachable }
        var request = URLRequest(url: metaURL)
        request.timeoutInterval = 1.6
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        if let token = readToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { return .unreachable }
            if http.statusCode == 401 { return .unauthorized }
            guard http.statusCode == 200 else { return .otherService }
            guard let meta = try? JSONDecoder().decode(BridgeMeta.self, from: data) else {
                return .otherService
            }
            let ping = includePing ? await fetchPing() : nil
            return .live(meta, ping)
        } catch {
            return .unreachable
        }
    }

    private func fetchPing() async -> BridgePing? {
        guard let pingURL = apiURL(path: "/api/ping") else { return nil }
        var request = URLRequest(url: pingURL)
        request.timeoutInterval = 4
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        if let token = readToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        guard let (data, response) = try? await session.data(for: request),
              let http = response as? HTTPURLResponse,
              http.statusCode == 200
        else { return nil }
        return try? JSONDecoder().decode(BridgePing.self, from: data)
    }

    private func apiURL(path: String) -> URL? {
        var components = URLComponents()
        components.scheme = "http"
        components.host = "127.0.0.1"
        components.port = activePort
        components.path = path
        return components.url
    }

    // MARK: - Endpoints & token

    private func makeURL(host: String, port: Int, includeToken: Bool = true) -> String {
        var components = URLComponents()
        components.scheme = "http"
        components.host = host
        components.port = port
        components.path = "/"
        if includeToken, !token.isEmpty {
            components.queryItems = [URLQueryItem(name: "token", value: token)]
        }
        return components.string ?? "http://\(host):\(port)/"
    }

    func refreshEndpoints() {
        token = readToken() ?? ""
        let linkPort = listenerPort
        var next: [ServerEndpoint] = []
        for interface in listenerAllowsLAN ? networkInterfaces() : [] {
            let kind: ServerEndpoint.Kind
            let title: String
            switch interface.kind {
            case .lan:
                kind = .lan
                title = "局域网 · \(interface.name)"
            case .tailscale:
                kind = .tailscale
                title = "Tailscale"
            case .other:
                kind = .other
                title = "网络 · \(interface.name)"
            }
            next.append(ServerEndpoint(
                id: interface.id,
                title: title,
                detail: interface.address,
                urlString: makeURL(host: interface.address, port: linkPort),
                kind: kind
            ))
        }
        next.append(ServerEndpoint(
            id: "local",
            title: "本机",
            detail: "127.0.0.1",
            urlString: makeURL(host: "127.0.0.1", port: linkPort),
            kind: .local
        ))
        endpoints = next.sorted { lhs, rhs in
            if lhs.kind != rhs.kind { return lhs.kind < rhs.kind }
            return lhs.detail.localizedStandardCompare(rhs.detail) == .orderedAscending
        }
    }

    func maskedURL(_ url: String) -> String {
        guard !token.isEmpty else { return url }
        return url.replacingOccurrences(of: token, with: "••••••••")
    }

    func copyPrimaryLink() {
        guard let link = primaryURLString else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(link, forType: .string)
    }

    func copy(_ string: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(string, forType: .string)
    }

    func copyToken() {
        guard !token.isEmpty else { return }
        copy(token)
    }

    func openInBrowser() {
        guard let link = primaryURLString, let url = URL(string: link) else { return }
        NSWorkspace.shared.open(url)
    }

    func openLocalInBrowser() {
        let link = makeURL(host: "127.0.0.1", port: activePort)
        if let url = URL(string: link) { NSWorkspace.shared.open(url) }
    }

    private func readToken() -> String? {
        let url = dataFolder.appendingPathComponent("token")
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    func regenerateToken() async {
        guard ownsServer, phase == .running else {
            lastError = "只有由 Codex Remote 启动的服务器才能在这里重新生成令牌。"
            return
        }
        monitorTask?.cancel()
        setPhase(.stopping, "正在重新生成令牌…")
        await bridge.stop()
        ownsServer = false
        let tokenURL = dataFolder.appendingPathComponent("token")
        try? FileManager.default.removeItem(at: tokenURL)
        token = ""
        refreshEndpoints()
        setPhase(.stopped, "正在重新生成令牌…")
        await startServer()
    }

    func renameBridge(_ name: String) async -> String? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "名称不能为空" }
        guard !token.isEmpty, let url = apiURL(path: "/api/meta") else {
            return "服务器还没有就绪"
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 3
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["name": trimmed])
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                return "保存失败（HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)）"
            }
            if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let saved = object["name"] as? String {
                bridgeName = saved
            } else {
                bridgeName = trimmed
            }
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    // MARK: - Logs

    func refreshLogTail() {
        let url = BridgeManager.expectedLogURL()
        guard let text = try? String(contentsOf: url, encoding: .utf8), !text.isEmpty else {
            logTail = ""
            return
        }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        var tail = lines.suffix(28).joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        if !token.isEmpty {
            tail = tail.replacingOccurrences(of: token, with: "••••••••")
        }
        logTail = tail
    }

    func openLog() {
        let url = BridgeManager.expectedLogURL()
        if !FileManager.default.fileExists(atPath: url.path) {
            try? FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        NSWorkspace.shared.open(url)
    }

    func openDataFolder() {
        try? FileManager.default.createDirectory(at: dataFolder, withIntermediateDirectories: true)
        NSWorkspace.shared.open(dataFolder)
    }

    func revealBridgeFolder() {
        let url = bridge.bridgeDirectory ?? bridge.locateBridge()
        guard let url else { return }
        NSWorkspace.shared.open(url)
    }

    // MARK: - Launch at login

    func setLaunchAtLogin(_ enabled: Bool) {
        if enabled == launchAtLogin { return }
        loginItemError = nil
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            loginItemError = "登录项设置失败：\(error.localizedDescription)"
        }
        refreshLaunchAtLogin()
        if SMAppService.mainApp.status == .requiresApproval {
            loginItemError = "需要在「系统设置 → 通用 → 登录项」里允许 Codex Remote。"
        }
    }

    func refreshLaunchAtLogin() {
        launchAtLogin = SMAppService.mainApp.status == .enabled
    }

    // MARK: - Menu bar / dock

    private func applyActivationPolicy() {
        NSApp.setActivationPolicy(showInDock ? .regular : .accessory)
    }

    // MARK: - Keep awake

    private func refreshKeepAwake() {
        if keepAwake && phase == .running {
            beginKeepAwake()
        } else {
            endKeepAwake()
        }
    }

    private func beginKeepAwake() {
        guard activityToken == nil else { return }
        activityToken = ProcessInfo.processInfo.beginActivity(
            options: [.idleSystemSleepDisabled, .userInitiated, .automaticTerminationDisabled],
            reason: "Codex Remote 服务器正在保持在线"
        )
    }

    private func endKeepAwake() {
        guard let activityToken else { return }
        ProcessInfo.processInfo.endActivity(activityToken)
        self.activityToken = nil
    }


    // MARK: - Snapshot demo state

    /// Fills the model with believable values for the offscreen dashboard
    /// preview. Never used by the shipped app.
    func loadDemoState() {
        phase = .running
        detail = "服务器正在运行"
        ownsServer = true
        bridgeVersion = "1.10.1"
        bridgeName = "Demo Mac"
        hostName = "demo-mac.local"
        daemonConnected = true
        daemonLatency = 12
        serverLatency = 1.4
        clientCount = 2
        startedAt = Date().addingTimeInterval(-(2 * 3600 + 18 * 60))
        uptime = 2 * 3600 + 18 * 60
        activePort = 8787
        activeLAN = true
        token = "example-token-not-for-login"
        revealToken = true
        lastError = nil
        logTail = """
        Codex Remote bridge running
          app-server socket : ~/.codex/app-server-control/app-server-control.sock
          listening         : http://0.0.0.0:8787
          token file        : ~/.codex-remote/token

        14:32:07 app-server connected (v1.10.1)
        14:32:07 thread/list 40 sessions
        14:33:21 SSE client connected
        14:34:02 turn/started 01J9Z3K2
        14:34:18 approval/requested commandExecution
        14:34:31 turn/completed 01J9Z3K2
        14:35:44 SSE client connected
        """
        let port = 8787
        let tokenValue = token
        func url(_ host: String) -> String {
            "http://\(host):\(port)/?token=\(tokenValue)"
        }
        endpoints = [
            ServerEndpoint(id: "demo-lan", title: "局域网 · 示例", detail: "192.0.2.10", urlString: url("192.0.2.10"), kind: .lan),
            ServerEndpoint(id: "demo-tailscale", title: "Tailscale · 示例", detail: "192.0.2.20", urlString: url("192.0.2.20"), kind: .tailscale),
            ServerEndpoint(id: "local", title: "本机", detail: "127.0.0.1", urlString: url("127.0.0.1"), kind: .local),
        ]
    }

    // MARK: - Helpers

    private func setPhase(_ phase: Phase, _ detail: String) {
        self.phase = phase
        self.detail = detail
    }

    func dismissError() {
        lastError = nil
    }
}
