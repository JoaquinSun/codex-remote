import SwiftUI

struct InlineSettingsView: View {
    private enum Tab: String, CaseIterable, Identifiable {
        case server = "服务器"
        case access = "访问"
        case advanced = "高级"
        var id: Self { self }
    }

    @State private var selectedTab: Tab = .server

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Picker("设置分类", selection: $selectedTab) {
                ForEach(Tab.allCases) { tab in
                    Text(tab.rawValue).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(maxWidth: 360)

            switch selectedTab {
            case .server: ServerSettingsView()
            case .access: AccessSettingsView()
            case .advanced: AdvancedSettingsView()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct SettingsSection<Content: View>: View {
    let title: String
    var note: String?
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.secondary)
            content
            if let note {
                Text(note)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 10))
    }
}

// MARK: - Server

private struct ServerSettingsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var portText = ""
    @FocusState private var portFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            SettingsSection(title: "监听", note: "手机访问时使用电脑的局域网地址；Tailscale 用户在开启局域网监听后也可以直接接入。") {
                LabeledContent("端口") {
                    HStack(spacing: 6) {
                        TextField("端口", text: $portText)
                            .labelsHidden()
                            .textFieldStyle(.roundedBorder)
                            .multilineTextAlignment(.trailing)
                            .frame(width: 82)
                            .focused($portFocused)
                            .onSubmit(applyPort)
                        Button("应用") { applyPort() }
                            .disabled(!canApplyPort)
                    }
                }

                Picker("监听范围", selection: Binding(
                    get: { model.listenOnLAN },
                    set: { model.listenOnLAN = $0 }
                )) {
                    Text("局域网 / Tailscale（0.0.0.0）").tag(true)
                    Text("仅本机（127.0.0.1）").tag(false)
                }
                .pickerStyle(.radioGroup)

                if model.needsRestart {
                    HStack {
                        Label("端口或监听范围已修改，需要重启服务器。", systemImage: "exclamationmark.arrow.triangle.2.circlepath")
                            .font(.caption)
                            .foregroundStyle(.orange)
                        Spacer()
                        Button("立即重启") {
                            Task { await model.restartServer() }
                        }
                        .controlSize(.small)
                        .disabled(!model.ownsServer)
                    }
                }
            }

            SettingsSection(title: "启动与运行", note: "关闭 Dock 图标后，可以从菜单栏的服务器图标重新打开控制台。") {
                Toggle("启动 App 时自动启动服务器", isOn: Binding(
                    get: { model.autoStart },
                    set: { model.autoStart = $0 }
                ))
                Toggle("登录时自动打开 Codex Remote Server", isOn: Binding(
                    get: { model.launchAtLogin },
                    set: { model.setLaunchAtLogin($0) }
                ))
                if let error = model.loginItemError {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
                Toggle("防止电脑在服务器运行时休眠", isOn: Binding(
                    get: { model.keepAwake },
                    set: { model.keepAwake = $0 }
                ))
                Toggle("退出 App 时停止服务器", isOn: Binding(
                    get: { model.stopOnQuit },
                    set: { model.stopOnQuit = $0 }
                ))
                Toggle("在 Dock 中显示图标", isOn: Binding(
                    get: { model.showInDock },
                    set: { model.showInDock = $0 }
                ))
            }
        }
        .toggleStyle(.switch)
        .controlSize(.small)
        .onAppear { portText = String(model.port) }
        .onChange(of: model.port) { _, value in
            portText = String(value)
        }
    }

    private var canApplyPort: Bool {
        guard let value = Int(portText.trimmingCharacters(in: .whitespaces)) else { return false }
        return (1024...65535).contains(value) && value != model.port
    }

    private func applyPort() {
        guard let value = Int(portText.trimmingCharacters(in: .whitespaces)),
              (1024...65535).contains(value)
        else {
            portText = String(model.port)
            return
        }
        model.port = value
        portText = String(model.port)
        portFocused = false
    }
}

// MARK: - Access

private struct AccessSettingsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var nameDraft = ""
    @State private var saveMessage: String?
    @State private var confirmRegenerate = false
    @FocusState private var nameFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            SettingsSection(title: "访问令牌", note: "令牌写在 ~/.codex-remote/token，手机通过带 token 的接入地址登录。重新生成后需要使用新的接入地址。") {
                HStack(alignment: .firstTextBaseline) {
                    Text(model.revealToken ? model.token : "••••••••••••••••••••••••")
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer()
                    Toggle("显示", isOn: $model.revealToken)
                        .toggleStyle(.switch)
                        .controlSize(.mini)
                    Button("复制") { model.copyToken() }
                        .disabled(model.token.isEmpty)
                }

                HStack {
                    Button("重新生成令牌…") {
                        confirmRegenerate = true
                    }
                    .disabled(!model.ownsServer || model.isBusy)
                    Spacer()
                    Text(model.ownsServer ? "会让所有已登录页面退出" : "外部进程托管时不可用")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            SettingsSection(title: "显示名称", note: "多台电脑时用来区分来源，手机侧边栏和标题会显示这个名字。") {
                LabeledContent("电脑名称") {
                    HStack(spacing: 6) {
                        TextField("名称", text: $nameDraft)
                            .textFieldStyle(.roundedBorder)
                            .focused($nameFocused)
                            .frame(width: 180)
                        Button("保存") {
                            Task { await saveName() }
                        }
                        .disabled(nameDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                  || nameDraft == model.bridgeName)
                    }
                }
                if let saveMessage {
                    Text(saveMessage)
                        .font(.caption)
                        .foregroundStyle(saveMessage == "已保存" ? Color.secondary : Color.red)
                }
            }

            SettingsSection(title: "接入地址", note: "第一个局域网地址通常就是手机可用的地址；不在同一网络时使用 Tailscale。") {
                ForEach(model.endpoints) { endpoint in
                    HStack(spacing: 9) {
                        Image(systemName: endpoint.systemImage)
                            .foregroundStyle(.secondary)
                            .frame(width: 18)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(endpoint.title)
                                .font(.callout)
                            Text(model.revealToken ? endpoint.urlString : model.maskedURL(endpoint.urlString))
                                .font(.system(.caption2, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        Spacer()
                        Button("复制") { model.copy(endpoint.urlString) }
                            .controlSize(.small)
                    }
                }
            }
        }
        .onAppear {
            nameDraft = model.bridgeName
        }
        .onChange(of: model.bridgeName) { _, value in
            if !nameFocused { nameDraft = value }
        }
        .confirmationDialog("重新生成访问令牌？", isPresented: $confirmRegenerate, titleVisibility: .visible) {
            Button("重新生成", role: .destructive) {
                Task { await model.regenerateToken() }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("所有已经打开的手机页面需要打开新的接入地址。服务器会短暂重启。")
        }
    }

    private func saveName() async {
        if let error = await model.renameBridge(nameDraft) {
            saveMessage = error
        } else {
            saveMessage = "已保存"
            nameFocused = false
            nameDraft = model.bridgeName
        }
    }
}

// MARK: - Advanced

private struct AdvancedSettingsView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            SettingsSection(title: "运行时", note: "内置桥接用 Node.js 运行；改了路径之后需要重启服务器。") {
                TextField("Node.js 路径（留空自动检测）", text: Binding(
                    get: { model.nodePath },
                    set: { model.nodePath = $0 }
                ))
                .textFieldStyle(.roundedBorder)
                .font(.system(.caption, design: .monospaced))

                if let node = model.detectedNode {
                    Text("检测到：\(node)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                } else {
                    Text("没有检测到 Node.js。可以安装 Node.js，或在这里指定 node 可执行文件。")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }

            SettingsSection(title: "文件") {
                HStack {
                    Button("打开数据目录") { model.openDataFolder() }
                    Button("打开日志") { model.openLog() }
                    Button("显示内置桥接") { model.revealBridgeFolder() }
                    Spacer()
                }
            }

            SettingsSection(title: "关于") {
                LabeledContent("Codex Remote Server", value: model.appVersion)
                LabeledContent("内置桥接") {
                    Text(model.bridgeVersion.isEmpty ? "—" : "v\(model.bridgeVersion)")
                        .foregroundStyle(.secondary)
                }
                LabeledContent("监听", value: "\(model.activePort) · \(model.hostLabel)")
                if let startedAt = model.startedAt {
                    LabeledContent("本次启动", value: startedAt.formatted(date: .abbreviated, time: .standard))
                }
                HStack {
                    Link("项目主页", destination: URL(string: "https://github.com/JoaquinSun/codex-remote")!)
                    Spacer()
                    Text("本地优先 · 不经过第三方服务器")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
        }
    }
}
