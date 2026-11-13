import Foundation
import XCTest
@testable import CodexRemote

/// HTTP and process doubles keep lifecycle tests away from the user's bridge,
/// token file, preferences, and Codex sessions.
private final class StubServer: @unchecked Sendable {
    private let lock = NSLock()
    private var running = false
    private var host = "0.0.0.0"
    private var port = 18789
    private var reportsListener = true
    private var requestedPorts: [Int] = []

    func start(host: String, port: Int, reportsListener: Bool = true) {
        lock.lock()
        defer { lock.unlock() }
        running = true
        self.host = host
        self.port = port
        self.reportsListener = reportsListener
    }

    func stop() {
        lock.lock()
        defer { lock.unlock() }
        running = false
    }

    var ports: [Int] {
        lock.lock()
        defer { lock.unlock() }
        return requestedPorts
    }

    func response(to request: URLRequest) throws -> Data {
        lock.lock()
        defer { lock.unlock() }
        requestedPorts.append(request.url?.port ?? 0)
        guard running, request.url?.port == port else { throw URLError(.cannotConnectToHost) }
        let body: [String: Any]
        if request.url?.path == "/api/meta" {
            var meta: [String: Any] = [
                "name": "Isolated test bridge", "version": "test", "connected": true,
                "startedAt": Date().timeIntervalSince1970 * 1000,
            ]
            if reportsListener { meta["listenHost"] = host }
            body = meta
        } else if request.url?.path == "/api/usage" {
            body = [
                "fetchedAt": Date().timeIntervalSince1970 * 1000,
                "codex": [
                    "available": true,
                    "limits": [[
                        "limitId": "codex", "planType": "pro",
                        "primary": ["usedPercent": 24, "windowDurationMins": 300],
                        "secondary": ["usedPercent": 11, "windowDurationMins": 10_080],
                    ]],
                ],
                "ccSwitch": [
                    "available": true,
                    "period": "today",
                    "summary": [
                        "requests": 204, "realTotalTokens": 25_220_000,
                        "totalCostUsd": 9.9,
                    ],
                ],
            ]
        } else {
            body = ["ok": true, "connected": true, "clients": 0, "serverMs": 1]
        }
        return try JSONSerialization.data(withJSONObject: body)
    }
}

private final class StubURLProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var servers: [String: StubServer] = [:]

    static func register(_ server: StubServer, id: String) {
        lock.lock()
        defer { lock.unlock() }
        servers[id] = server
    }

    static func unregister(_ id: String) {
        lock.lock()
        defer { lock.unlock() }
        servers.removeValue(forKey: id)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        let server = Self.servers[request.value(forHTTPHeaderField: "X-Codex-Remote-Test") ?? ""]
        Self.lock.unlock()
        do {
            guard let server, let url = request.url else { throw URLError(.badURL) }
            let data = try server.response(to: request)
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil,
                                           headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

@MainActor
private final class StubBridge: BridgeManaging {
    struct Start {
        let port: Int
        let host: String
    }

    let server: StubServer
    var isRunning = false
    var bridgeDirectory: URL? { nil }
    var starts: [Start] = []
    var stopCalls = 0
    var startError: Error?

    init(server: StubServer) { self.server = server }
    func locateBridge() -> URL? { nil }
    func logTail(maxLines: Int) -> String { "" }

    func start(port: Int, host: String, explicitNode: String?, onExit: @escaping (Int32) -> Void) throws {
        if let startError { throw startError }
        starts.append(Start(port: port, host: host))
        isRunning = true
        server.start(host: host, port: port)
    }

    func stop() async {
        stopCalls += 1
        isRunning = false
        server.stop()
    }

    func stopNow() {
        isRunning = false
        server.stop()
    }
}

@MainActor
final class AppModelTests: XCTestCase {
    private func fixture(lan: Bool = true) throws -> (AppModel, StubBridge, StubServer) {
        let id = UUID().uuidString
        let suite = "CodexRemote.tests.\(id)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.setVolatileDomain([
            "CodexRemote.port": 18789,
            "CodexRemote.listenOnLAN": lan,
            "CodexRemote.keepAwake": false,
        ], forName: UserDefaults.argumentDomain)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(suite)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try "isolated-test-token".write(to: directory.appendingPathComponent("token"), atomically: true, encoding: .utf8)
        let server = StubServer()
        let bridge = StubBridge(server: server)
        StubURLProtocol.register(server, id: id)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        configuration.httpAdditionalHeaders = ["X-Codex-Remote-Test": id]
        let session = URLSession(configuration: configuration)
        let model = AppModel(bridge: bridge, defaults: defaults, session: session,
                             dataFolder: directory, networkInterfaces: {
            [Network.Interface(id: "lan", name: "en0", address: "192.168.1.9", kind: .lan),
             Network.Interface(id: "tailscale", name: "utun0", address: "100.80.1.9", kind: .tailscale)]
        })
        addTeardownBlock { @MainActor in
            model.shutdown()
            session.invalidateAndCancel()
            StubURLProtocol.unregister(id)
            defaults.removePersistentDomain(forName: suite)
            try FileManager.default.removeItem(at: directory)
        }
        return (model, bridge, server)
    }

    func testRestartStopsAndStartsOwnedBridgeAndReturnsToRunning() async throws {
        let (model, bridge, _) = try fixture()
        await model.startServer()
        XCTAssertEqual(model.phase, .running)
        XCTAssertTrue(model.ownsServer)

        await model.restartServer()

        XCTAssertEqual(bridge.stopCalls, 1)
        XCTAssertEqual(bridge.starts.count, 2)
        XCTAssertEqual(model.phase, .running)
        XCTAssertFalse(model.isBusy)
        XCTAssertTrue(model.canStop)
    }

    func testLoopbackListenerOnlyOffersLocalAccessURL() async throws {
        let (model, bridge, _) = try fixture(lan: false)
        await model.startServer()

        XCTAssertEqual(bridge.starts.first?.host, "127.0.0.1")
        XCTAssertEqual(model.endpoints.map(\.kind), [.local])
        XCTAssertEqual(URL(string: try XCTUnwrap(model.primaryURLString))?.host, "127.0.0.1")
        XCTAssertTrue(model.hostLabel.contains("127.0.0.1"))
    }

    func testUsageSnapshotPopulatesCodexAndCCSwitchTiles() async throws {
        let (model, _, _) = try fixture()
        await model.startServer()
        await model.refreshUsageNow()

        XCTAssertEqual(model.codexLimitText, "24% · 11%")
        XCTAssertTrue(model.codexLimitDetail.contains("5 小时"))
        XCTAssertTrue(model.codexLimitDetail.contains("7 天"))
        XCTAssertTrue(model.codexLimitAvailable)
        XCTAssertEqual(model.codexLimitUsedPercent, 24)
        XCTAssertEqual(model.ccSwitchUsageText, "2522 万 Token")
        XCTAssertEqual(model.ccSwitchUsageDetail, "今日 · 204 次 · $9.90")
        XCTAssertTrue(model.ccSwitchUsageAvailable)

        await model.stopServer()
        XCTAssertFalse(model.codexLimitAvailable)
        XCTAssertEqual(model.codexLimitText, "—")
        XCTAssertFalse(model.ccSwitchUsageAvailable)
        XCTAssertEqual(model.ccSwitchUsageText, "—")
    }

    func testLANToLoopbackChangeKeepsLiveURLsUntilRestart() async throws {
        let (model, bridge, _) = try fixture()
        await model.startServer()
        model.listenOnLAN = false
        model.port = 18790

        XCTAssertTrue(model.needsRestart)
        XCTAssertEqual(model.primaryEndpoint?.kind, .lan)
        XCTAssertTrue(model.hostLabel.contains("0.0.0.0"))
        XCTAssertTrue(model.endpoints.allSatisfy { URL(string: $0.urlString)?.port == 18789 })

        await model.restartServer()

        XCTAssertEqual(model.phase, .running)
        XCTAssertFalse(model.needsRestart)
        XCTAssertEqual(bridge.starts.last?.host, "127.0.0.1")
        XCTAssertEqual(bridge.starts.last?.port, 18790)
        XCTAssertEqual(model.endpoints.map(\.kind), [.local])
        XCTAssertTrue(model.endpoints.allSatisfy { URL(string: $0.urlString)?.port == 18790 })
    }

    func testLoopbackToLANChangeKeepsOnlyLocalURLUntilRestart() async throws {
        let (model, _, _) = try fixture(lan: false)
        await model.startServer()
        model.listenOnLAN = true
        XCTAssertTrue(model.needsRestart)
        XCTAssertEqual(model.endpoints.map(\.kind), [.local])
        XCTAssertTrue(model.hostLabel.contains("127.0.0.1"))

        await model.restartServer()

        XCTAssertEqual(model.phase, .running)
        XCTAssertFalse(model.needsRestart)
        XCTAssertEqual(Set(model.endpoints.map(\.kind)), [.lan, .tailscale, .local])
    }

    func testExternalListenerMetadataOverridesUnappliedAppPreference() async throws {
        let (model, bridge, server) = try fixture()
        server.start(host: "127.0.0.1", port: 18789)
        await model.startServer()

        XCTAssertEqual(model.phase, .running)
        XCTAssertFalse(model.ownsServer)
        XCTAssertTrue(bridge.starts.isEmpty)
        XCTAssertEqual(model.endpoints.map(\.kind), [.local])
        XCTAssertTrue(model.needsRestart)

        await model.restartServer()
        XCTAssertEqual(bridge.stopCalls, 0)
        XCTAssertNotNil(model.lastError)
        XCTAssertEqual(model.phase, .running)
    }

    func testLegacyMetaDoesNotOverwriteTheActivePortOrListener() async throws {
        let (model, _, server) = try fixture(lan: false)
        await model.startServer()
        server.start(host: "127.0.0.1", port: 18789, reportsListener: false)
        model.listenOnLAN = true
        model.port = 18790
        let previousRequests = server.ports.count
        model.reconnect()
        // Wait for the two intercepted HTTP requests made by reconnect().
        for _ in 0..<100 {
            if server.ports.count >= previousRequests + 2 { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }

        XCTAssertEqual(server.ports.last, 18789)
        XCTAssertGreaterThanOrEqual(server.ports.count, previousRequests + 2)
        XCTAssertEqual(model.activePort, 18789)
        XCTAssertFalse(model.activeLAN)
        XCTAssertEqual(model.endpoints.map(\.kind), [.local])
        XCTAssertTrue(model.needsRestart)
    }

    func testFailedRestartLeavesControlsUsable() async throws {
        let (model, bridge, _) = try fixture()
        await model.startServer()
        bridge.startError = NSError(domain: "CodexRemote.test", code: 1)

        await model.restartServer()

        XCTAssertEqual(model.phase, .failed)
        XCTAssertFalse(model.isBusy)
        XCTAssertFalse(model.ownsServer)
        XCTAssertFalse(bridge.isRunning)
        XCTAssertNotNil(model.lastError)
    }
}
