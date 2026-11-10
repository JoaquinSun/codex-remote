import SwiftUI

struct DashboardView: View {
    @EnvironmentObject private var model: AppModel
    @State private var copiedID: String?
    var autoBootstrap: Bool = true
    var scrollable: Bool = true

    var body: some View {
        Group {
            if scrollable {
                ScrollViewReader { proxy in
                    ScrollView {
                        content
                    }
                    .onReceive(model.$settingsExpanded) { expanded in
                        guard expanded else { return }
                        DispatchQueue.main.async {
                            withAnimation(.easeInOut(duration: 0.2)) {
                                proxy.scrollTo("dashboard-settings", anchor: .top)
                            }
                        }
                    }
                }
                .background(DashboardBackground())
            } else {
                content
                    .background(DashboardBackground())
            }
        }
        .frame(minWidth: 900, minHeight: 620)
        .onAppear {
            if autoBootstrap { model.bootstrap() }
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 16) {
            header

            if let error = model.lastError {
                errorBanner(error)
            }
            if model.needsRestart {
                restartBanner
            }

            if model.settingsExpanded {
                settingsCard
                    .id("dashboard-settings")
            }

            accessCard
            statsGrid

            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 340), spacing: 16)],
                alignment: .leading,
                spacing: 16
            ) {
                detailsCard
                logsCard
            }

            footer
        }
        .padding(24)
        .frame(maxWidth: 1040, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .center)
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .center, spacing: 14) {
            ServerMark(size: 50)

            VStack(alignment: .leading, spacing: 3) {
                Text("Codex Remote Server")
                    .font(.system(size: 23, weight: .semibold, design: .default))
                    .tracking(-0.3)
                Text("把这台 Mac 上的 Codex 会话安全地接到手机和浏览器")
                    .font(.system(size: 12.5))
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 12)

            StatusPill(model: model)

            Button {
                model.settingsExpanded.toggle()
            } label: {
                Image(systemName: "gearshape")
                    .font(.system(size: 13, weight: .medium))
                    .frame(width: 20, height: 20)
            }
            .buttonStyle(.bordered)
            .help(model.settingsExpanded ? "收起设置" : "展开设置")
            .accessibilityLabel("设置")
            .accessibilityValue(model.settingsExpanded ? "已展开" : "已收起")

            Button {
                Task { await model.restartServer() }
            } label: {
                Image(systemName: "arrow.clockwise")
                    .frame(width: 20, height: 20)
            }
            .buttonStyle(.bordered)
            .disabled(model.isBusy || !model.ownsServer)
            .help("重启服务器")

            controlButton
        }
    }

    @ViewBuilder
    private var controlButton: some View {
        if model.phase == .starting || model.phase == .stopping {
            Button {
                model.toggleServer()
            } label: {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text(model.phase == .starting ? "启动中…" : "停止中…")
                }
                .frame(minWidth: 78)
            }
            .buttonStyle(.borderedProminent)
            .disabled(true)
        } else if model.isRunning {
            Button {
                model.toggleServer()
            } label: {
                Label(model.canStop ? "停止服务器" : "外部进程运行中", systemImage: "stop.fill")
                    .frame(minWidth: 100)
            }
            .buttonStyle(.bordered)
            .disabled(!model.canStop)
            .help(model.canStop ? "停止本机服务器" : "这个服务器不是由本 App 启动的")
        } else {
            Button {
                model.toggleServer()
            } label: {
                Label("启动服务器", systemImage: "play.fill")
                    .frame(minWidth: 100)
            }
            .buttonStyle(.borderedProminent)
        }
    }

    // MARK: - Banners

    private var settingsCard: some View {
        DashboardCard {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top) {
                    SectionHeader(icon: "gearshape", title: "设置",
                                  subtitle: "在这里调整服务器、访问和运行时选项。")
                    Spacer()
                    Button("收起设置") {
                        model.settingsExpanded = false
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }

                InlineSettingsView()
            }
        }
        .accessibilityIdentifier("dashboard-settings")
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
                .font(.system(size: 14))
            VStack(alignment: .leading, spacing: 4) {
                Text("服务器需要注意")
                    .font(.system(size: 12.5, weight: .semibold))
                Text(message)
                    .font(.system(size: 11.5))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .lineLimit(10)
            }
            Spacer(minLength: 8)
            Button("打开日志") { model.openLog() }
                .buttonStyle(.link)
                .font(.system(size: 11.5))
            Button {
                model.dismissError()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.borderless)
            .help("忽略")
        }
        .padding(12)
        .background(Color.orange.opacity(0.09), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .strokeBorder(Color.orange.opacity(0.22), lineWidth: 1)
        )
    }

    private var restartBanner: some View {
        HStack(spacing: 10) {
            Image(systemName: "arrow.triangle.2.circlepath")
                .foregroundStyle(.blue)
            Text("端口或监听范围已经修改，重启服务器后生效。")
                .font(.system(size: 12))
            Spacer()
            Button("立即重启") {
                Task { await model.restartServer() }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(!model.ownsServer)
        }
        .padding(11)
        .background(Color.blue.opacity(0.08), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(Color.blue.opacity(0.18), lineWidth: 1)
        )
    }

    // MARK: - Access

    private var accessCard: some View {
        DashboardCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeader(
                    icon: "iphone.and.arrow.forward",
                    title: "设备接入",
                    subtitle: "复制下面的接入地址，在手机或另一台电脑的浏览器中打开。"
                )

                VStack(spacing: 7) {
                    ForEach(model.endpoints) { endpoint in
                        endpointRow(endpoint)
                    }
                }

                HStack(spacing: 8) {
                    Button {
                        model.openInBrowser()
                    } label: {
                        Label("在浏览器中打开", systemImage: "safari")
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.regular)
                    .disabled(!model.isRunning)

                    Button {
                        model.copyPrimaryLink()
                        flashCopied("primary")
                    } label: {
                        Label(copiedID == "primary" ? "已复制" : "复制接入地址",
                              systemImage: copiedID == "primary" ? "checkmark" : "doc.on.doc")
                    }
                    .buttonStyle(.bordered)
                    .disabled(!model.isRunning || model.primaryURLString == nil)

                    Spacer()

                    Toggle(isOn: $model.revealToken) {
                        Text("显示令牌")
                            .font(.system(size: 11.5))
                    }
                    .toggleStyle(.switch)
                    .controlSize(.small)
                    .help("显示接入地址中的完整令牌")
                }

                if model.token.isEmpty {
                    Label("还没有读到 token 文件，服务器可能在启动中。", systemImage: "key.slash")
                        .font(.system(size: 11))
                        .foregroundStyle(.orange)
                } else if model.revealToken {
                    Label("令牌等同于登录凭证，请只在自己信任的设备上打开接入地址。", systemImage: "lock.open")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func endpointRow(_ endpoint: AppModel.ServerEndpoint) -> some View {
        HStack(spacing: 9) {
            Image(systemName: endpoint.systemImage)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(endpoint.isLocal ? Color.secondary : Color.accentColor)
                .frame(width: 20)

            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(endpoint.title)
                        .font(.system(size: 11.5, weight: .semibold))
                    Text(endpoint.detail)
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(.tertiary)
                }
                Text(model.revealToken ? endpoint.urlString : model.maskedURL(endpoint.urlString))
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
            }

            Spacer(minLength: 6)

            Button {
                model.copy(endpoint.urlString)
                flashCopied(endpoint.id)
            } label: {
                Image(systemName: copiedID == endpoint.id ? "checkmark" : "doc.on.doc")
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(copiedID == endpoint.id ? Color.green : Color.secondary)
                    .frame(width: 22, height: 22)
            }
            .buttonStyle(.borderless)
            .help("复制完整地址")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    // MARK: - Stats

    private var statsGrid: some View {
        LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 200), spacing: 12)],
            spacing: 12
        ) {
            StatTile(
                icon: "terminal",
                title: "Codex",
                value: model.daemonConnected ? "已连接" : "未连接",
                detail: model.daemonConnected ? "app-server daemon" : "检查 Codex 桌面 App",
                tint: model.daemonConnected ? .green : .orange
            )
            StatTile(
                icon: "iphone.radio",
                title: "实时连接",
                value: model.clientCountText,
                detail: "个浏览器 / 手机",
                tint: .blue
            )
            StatTile(
                icon: "timer",
                title: "桥接延时",
                value: model.daemonLatencyText,
                detail: "电脑 ↔ Codex",
                tint: .purple
            )
            StatTile(
                icon: "clock",
                title: "运行时长",
                value: model.uptimeText,
                detail: model.startedAt == nil ? "尚未启动" : "自本次启动",
                tint: .secondary
            )
        }
    }

    // MARK: - Details

    private var detailsCard: some View {
        DashboardCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeader(icon: "server.rack", title: "服务详情")

                Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 8) {
                    detailRow("端口", "\(model.activePort)")
                    detailRow("监听范围", model.hostLabel)
                    detailRow("服务进程", model.ownsServer ? "由本 App 启动" : "外部进程")
                    detailRow("电脑名称", model.bridgeName.isEmpty ? "—" : model.bridgeName)
                    detailRow("桥接版本", model.bridgeVersion.isEmpty ? "—" : "v\(model.bridgeVersion)")
                    detailRow("Node", model.detectedNode ?? "未检测到")
                    detailRow("数据目录", "~/.codex-remote")
                }
                .font(.system(size: 11.5))

                Divider()

                HStack(spacing: 12) {
                    Toggle("随 App 启动", isOn: Binding(
                        get: { model.autoStart },
                        set: { model.autoStart = $0 }
                    ))
                    .toggleStyle(.switch)
                    .controlSize(.small)

                    Spacer()

                    Button("打开数据目录") { model.openDataFolder() }
                        .buttonStyle(.link)
                        .font(.system(size: 11.5))
                    Button("打开日志") { model.openLog() }
                        .buttonStyle(.link)
                        .font(.system(size: 11.5))
                }
            }
        }
    }

    private func detailRow(_ title: String, _ value: String) -> some View {
        GridRow {
            Text(title)
                .foregroundStyle(.secondary)
                .frame(width: 64, alignment: .leading)
            Text(value)
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
        }
    }

    private var logsCard: some View {
        DashboardCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    SectionHeader(icon: "text.alignleft", title: "最近日志")
                    Spacer()
                    Button("打开日志") { model.openLog() }
                        .buttonStyle(.link)
                        .font(.system(size: 11.5))
                }

                ScrollView {
                    Text(model.logTail.isEmpty ? "暂无日志" : model.logTail)
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(model.logTail.isEmpty ? .secondary : .primary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(9)
                }
                .frame(height: 168)
                .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
        }
    }

    // MARK: - Footer

    private var footer: some View {
        HStack(spacing: 8) {
            Text("Codex Remote Server \(model.appVersion)")
            if !model.bridgeVersion.isEmpty {
                Text("· 桥接 v\(model.bridgeVersion)")
            }
            Spacer()
            Label("手机和 Mac 在同一网络，或都接入 Tailscale", systemImage: "network")
        }
        .font(.system(size: 10.5))
        .foregroundStyle(.tertiary)
        .padding(.top, 2)
    }

    // MARK: - Helpers

    private func flashCopied(_ id: String) {
        copiedID = id
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            if copiedID == id { copiedID = nil }
        }
    }
}

// MARK: - Shared pieces

private struct DashboardCard<Content: View>: View {
    @ViewBuilder let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        content
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.07), lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.07), radius: 16, y: 7)
    }
}

private struct SectionHeader: View {
    let icon: String
    let title: String
    var subtitle: String?

    init(icon: String, title: String, subtitle: String? = nil) {
        self.icon = icon
        self.title = title
        self.subtitle = subtitle
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 7) {
                Image(systemName: icon)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.secondary)
                Text(title)
                    .font(.system(size: 13, weight: .semibold))
            }
            if let subtitle {
                Text(subtitle)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
        }
    }
}

private struct StatusPill: View {
    @ObservedObject var model: AppModel

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
            Text(model.statusTitle)
                .font(.system(size: 11, weight: .semibold))
        }
        .foregroundStyle(color)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(color.opacity(0.12), in: Capsule())
        .overlay(Capsule().strokeBorder(color.opacity(0.16), lineWidth: 1))
        .help(model.statusSubtitle)
    }

    private var color: Color {
        switch model.phase {
        case .running: return .green
        case .starting, .stopping: return .orange
        case .failed: return .red
        case .stopped: return .secondary
        }
    }
}

private struct StatTile: View {
    let icon: String
    let title: String
    let value: String
    let detail: String
    let tint: Color

    var body: some View {
        HStack(alignment: .top, spacing: 11) {
            Image(systemName: icon)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: 28, height: 28)
                .background(tint.opacity(0.1), in: RoundedRectangle(cornerRadius: 8, style: .continuous))

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(.secondary)
                Text(value)
                    .font(.system(size: 17, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                Text(detail)
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.06), lineWidth: 1)
        )
    }
}

private struct ServerMark: View {
    let size: CGFloat

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.27, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [Color(white: 0.20), Color(white: 0.055)],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
            RoundedRectangle(cornerRadius: size * 0.27, style: .continuous)
                .strokeBorder(Color.white.opacity(0.13), lineWidth: 1)

            HStack(spacing: size * 0.055) {
                Image(systemName: "chevron.right")
                    .font(.system(size: size * 0.34, weight: .semibold))
                    .foregroundStyle(Color.white.opacity(0.95))
                Capsule()
                    .fill(Color(red: 0.30, green: 0.64, blue: 1.0))
                    .frame(width: size * 0.24, height: size * 0.065)
                    .offset(y: size * 0.16)
            }
            .offset(x: size * 0.02)
        }
        .frame(width: size, height: size)
        .shadow(color: .black.opacity(0.18), radius: 8, y: 4)
    }
}

private struct DashboardBackground: View {
    var body: some View {
        ZStack {
            Color(nsColor: .windowBackgroundColor)
            LinearGradient(
                colors: [Color.accentColor.opacity(0.055), Color.clear],
                startPoint: .topTrailing,
                endPoint: .center
            )
        }
        .ignoresSafeArea()
    }
}
