import SwiftUI

@main
enum CodexRemoteLauncher {
    @MainActor
    static func main() {
        if let index = CommandLine.arguments.firstIndex(of: "--render-snapshot") {
            let path = CommandLine.arguments.count > index + 1
                ? CommandLine.arguments[index + 1]
                : "codex-remote-dashboard.png"
            SnapshotRenderer.render(to: path)
            return
        }
        DemoMode.isActive = CommandLine.arguments.contains("--capture-demo")
        if let index = CommandLine.arguments.firstIndex(of: "--capture-window") {
            let path = CommandLine.arguments.count > index + 1
                ? CommandLine.arguments[index + 1]
                : "codex-remote-window.png"
            WindowCapture.request(path)
        }
        CodexRemoteServerApp.main()
    }
}

struct CodexRemoteServerApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel()

    var body: some Scene {
        Window("Codex Remote Server", id: "dashboard") {
            DashboardView()
                .environmentObject(model)
                .onAppear {
                    appDelegate.model = model
                    model.bootstrap()
                }
        }
        .defaultSize(width: 1040, height: 780)
        .windowResizability(.contentMinSize)
        .commands {
            ServerCommands(model: model)
        }

        MenuBarExtra {
            ServerMenu()
                .environmentObject(model)
        } label: {
            Image(systemName: model.isRunning ? "server.rack" : "bolt.slash")
                .help(model.isRunning ? "Codex Remote Server 正在运行" : "Codex Remote Server 已停止")
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    weak var model: AppModel?

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        WindowCapture.scheduleIfRequested()
    }

    func applicationWillTerminate(_ notification: Notification) {
        model?.shutdown()
    }
}

struct ServerCommands: Commands {
    @ObservedObject var model: AppModel
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        CommandGroup(replacing: .newItem) {}

        CommandGroup(replacing: .appSettings) {
            Button("设置…") {
                model.settingsExpanded = true
                NSApp.activate(ignoringOtherApps: true)
                openWindow(id: "dashboard")
            }
            .keyboardShortcut(",", modifiers: .command)
        }

        CommandMenu("服务器") {
            if model.isRunning {
                Button("停止服务器") {
                    Task { await model.stopServer() }
                }
                .disabled(!model.canStop)
            } else {
                Button("启动服务器") {
                    Task { await model.startServer() }
                }
                .disabled(model.isBusy)
            }

            Button("重启服务器") {
                Task { await model.restartServer() }
            }
            .disabled(!model.ownsServer || model.isBusy)

            Divider()

            Button("在浏览器中打开") {
                model.openInBrowser()
            }
            .disabled(!model.isRunning)

            Button("复制接入地址") {
                model.copyPrimaryLink()
            }
            .disabled(!model.isRunning)

            Button("重新生成令牌") {
                Task { await model.regenerateToken() }
            }
            .disabled(!model.ownsServer || model.isBusy)

            Divider()

            Button("打开日志") {
                model.openLog()
            }

            Button("打开数据目录") {
                model.openDataFolder()
            }
        }

        CommandGroup(replacing: .help) {
            Link(
                "Codex Remote 项目主页",
                destination: URL(string: "https://github.com/JoaquinSun/codex-remote")!
            )
        }
    }
}

struct ServerMenu: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Text(model.statusTitle)
        if model.isRunning, let endpoint = model.primaryEndpoint {
            Text("\(endpoint.detail):\(model.activePort)")
        }
        if let error = model.lastError {
            Text(error.split(separator: "\n").first.map(String.init) ?? "需要检查服务器")
        }

        Divider()

        Button("显示控制台") {
            showDashboard()
        }
        .keyboardShortcut("0")

        Button("在浏览器中打开") {
            model.openInBrowser()
        }
        .disabled(!model.isRunning)

        Button("复制接入地址") {
            model.copyPrimaryLink()
        }
        .disabled(!model.isRunning)

        Divider()

        if model.isRunning {
            Button("停止服务器") {
                Task { await model.stopServer() }
            }
            .disabled(!model.canStop)
        } else {
            Button("启动服务器") {
                Task { await model.startServer() }
            }
            .disabled(model.isBusy)
        }

        Button("重启服务器") {
            Task { await model.restartServer() }
        }
        .disabled(!model.ownsServer || model.isBusy)

        Divider()

        Button("设置…") {
            model.settingsExpanded = true
            showDashboard()
        }

        Button("打开日志") {
            model.openLog()
        }

        Divider()

        Button("退出 Codex Remote Server") {
            NSApplication.shared.terminate(nil)
        }
        .keyboardShortcut("q")
    }

    private func showDashboard() {
        NSApp.activate(ignoringOtherApps: true)
        openWindow(id: "dashboard")
        for window in NSApp.windows where window.canBecomeMain {
            window.makeKeyAndOrderFront(nil)
        }
    }
}
