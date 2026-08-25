import SwiftUI
import UIKit

struct ContentView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Group {
            if model.isPaired {
                DashboardView()
            } else {
                PairingView()
            }
        }
        .tint(.red)
        .alert("OrderPulse", isPresented: Binding(
            get: { model.errorMessage != nil },
            set: { if !$0 { model.errorMessage = nil } }
        )) {
            Button("知道了", role: .cancel) { model.errorMessage = nil }
        } message: {
            Text(model.errorMessage ?? "")
        }
    }
}

private struct PairingView: View {
    @EnvironmentObject private var model: AppModel
    @State private var code = ""
    @State private var deviceName = UIDevice.current.name

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    Image(systemName: "bolt.car.fill")
                        .font(.system(size: 48, weight: .semibold))
                        .foregroundStyle(.red)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 8) {
                        Text("连接你的 OrderPulse")
                            .font(.largeTitle.bold())
                        Text("在 NAS 管理端生成一次性配对码，然后在这里输入。App 不会保存管理员密码或 Tesla token。")
                            .foregroundStyle(.secondary)
                    }

                    VStack(alignment: .leading, spacing: 16) {
                        TextField("配对码，例如 ABCD-2345", text: $code)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                            .textContentType(.oneTimeCode)
                            .font(.title3.monospaced())
                            .padding()
                            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))
                            .accessibilityLabel("一次性配对码")
                        TextField("设备名称", text: $deviceName)
                            .textContentType(.name)
                            .padding()
                            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))

                        Button {
                            Task { await model.pair(code: code, deviceName: deviceName) }
                        } label: {
                            HStack {
                                if model.isLoading { ProgressView().tint(.white) }
                                Text(model.isLoading ? "正在连接…" : "连接 NAS")
                                    .frame(maxWidth: .infinity)
                            }
                            .padding(.vertical, 5)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .disabled(code.filter { $0.isLetter || $0.isNumber }.count != 8 || deviceName.trimmingCharacters(in: .whitespaces).isEmpty || model.isLoading)
                    }

                    Label("https://orderpulse.baodishan.com", systemImage: "lock.shield.fill")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("安全连接到 orderpulse.baodishan.com")
                }
                .padding(24)
            }
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

private struct DashboardView: View {
    @EnvironmentObject private var model: AppModel
    @State private var showingSettings = false

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if let bootstrap = model.bootstrap {
                        pollingSummary(bootstrap.polling)
                        if bootstrap.orders.isEmpty {
                            ContentUnavailableView(
                                "没有活跃订单",
                                systemImage: "car.side",
                                description: Text("等待下一次 NAS 轮询，或确认 Tesla 授权仍然有效。")
                            )
                        } else {
                            ForEach(bootstrap.orders) { order in
                                OrderCard(order: order)
                            }
                        }
                        if !bootstrap.events.isEmpty {
                            Text("变化记录")
                                .font(.title2.bold())
                                .padding(.top, 8)
                            ForEach(bootstrap.events) { event in
                                EventRow(event: event)
                            }
                        }
                    } else if model.isLoading {
                        ProgressView("正在读取 NAS 快照…")
                            .frame(maxWidth: .infinity)
                            .padding(.top, 80)
                    }
                }
                .padding()
            }
            .refreshable { await model.refresh() }
            .navigationTitle("OrderPulse")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("设置", systemImage: "gearshape") { showingSettings = true }
                }
            }
            .sheet(isPresented: $showingSettings) { SettingsView() }
            .task { if model.bootstrap == nil { await model.refresh() } }
        }
    }

    private func pollingSummary(_ polling: PollingStatus) -> some View {
        HStack(spacing: 10) {
            Circle()
                .fill(polling.enabled ? Color.green : Color.orange)
                .frame(width: 9, height: 9)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(polling.enabled ? "自动检查已开启" : "自动检查尚未开启")
                    .font(.subheadline.weight(.semibold))
                Text(polling.enabled ? "下次：\(DateText.display(polling.nextPollAt))" : "App 刷新只读取缓存，不会调用 Tesla")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding()
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
    }
}

private struct OrderCard: View {
    let order: OrderSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(order.modelCode?.uppercased() ?? "TESLA")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.secondary)
                    Text(order.primaryStatus.orderPulseDisplayCode)
                        .font(.title2.bold())
                }
                Spacer()
                Text(order.isActive ? "进行中" : "暂未出现")
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(order.isActive ? Color.green.opacity(0.14) : Color.orange.opacity(0.14), in: Capsule())
            }
            Divider()
            LabeledContent("订单", value: order.referenceNumber ?? "已隐藏")
            LabeledContent("主状态", value: order.orderStatus?.orderPulseDisplayCode ?? "—")
            LabeledContent("最近确认", value: DateText.display(order.lastSeenAt))
            LabeledContent("最近变化", value: DateText.display(order.lastChangedAt))
        }
        .padding(18)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20))
        .accessibilityElement(children: .contain)
    }
}

private struct EventRow: View {
    let event: OrderEvent

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: icon)
                .foregroundStyle(.red)
                .frame(width: 24)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.headline)
                if let previous = event.previousValue, let current = event.currentValue {
                    Text("\(previous.orderPulseDisplayCode) → \(current.orderPulseDisplayCode)")
                        .font(.subheadline)
                } else if let current = event.currentValue {
                    Text(current.orderPulseDisplayCode).font(.subheadline)
                }
                Text(DateText.display(event.createdAt))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.vertical, 8)
    }

    private var title: String {
        switch event.type {
        case "baseline_created": "开始追踪"
        case "status_changed": "订单状态更新"
        case "configuration_changed": "车辆配置更新"
        case "order_inactive": "订单暂未出现在列表"
        case "order_reappeared": "订单重新出现"
        default: "订单信息更新"
        }
    }

    private var icon: String {
        switch event.type {
        case "baseline_created": "scope"
        case "order_inactive": "exclamationmark.triangle"
        case "order_reappeared": "arrow.uturn.forward"
        default: "bell.badge"
        }
    }
}

private struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("后台") {
                    LabeledContent("地址", value: "orderpulse.baodishan.com")
                    LabeledContent("通知", value: model.notificationStatus)
                    Button("重新申请通知权限") { Task { await model.enableNotifications() } }
                }
                Section {
                    Button("解除这台设备的配对", role: .destructive) {
                        Task {
                            await model.unpair()
                            dismiss()
                        }
                    }
                } footer: {
                    Text("解除后 NAS 会撤销这台设备的访问凭证和 APNs token。Tesla 授权不会受到影响。")
                }
            }
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
        }
    }
}

#Preview("Pairing") {
    ContentView().environmentObject(AppModel())
}
