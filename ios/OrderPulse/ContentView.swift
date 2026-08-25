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
        VStack(alignment: .leading, spacing: 20) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(order.modelName)
                        .font(.title.bold())
                    Text(order.referenceNumber ?? "订单号已隐藏")
                        .font(.subheadline.monospaced())
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(order.orderStatus?.orderPulseDisplayCode ?? (order.isActive ? "进行中" : "暂未出现"))
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .foregroundStyle(order.isActive ? .blue : .orange)
                    .background(order.isActive ? Color.blue.opacity(0.12) : Color.orange.opacity(0.14), in: Capsule())
            }

            VStack(alignment: .leading, spacing: 12) {
                Text("订单进度")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.secondary)
                OrderProgressView(order: order)
            }

            if let details = order.delivery, details.hasUsefulData {
                Divider()
                DeliveryDetailsView(details: details)
            } else {
                Label("等待 Owner API 建立交付详情基线", systemImage: "hourglass")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            HStack {
                Label(DateText.display(order.lastSeenAt), systemImage: "arrow.clockwise")
                Spacer()
                Text("变化：\(DateText.display(order.lastChangedAt))")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(18)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20))
        .accessibilityElement(children: .contain)
    }
}

private struct OrderProgressView: View {
    let order: OrderSnapshot

    private var steps: [(String, String, Bool)] {
        let details = order.delivery
        return [
            ("下单", "doc.text.fill", true),
            ("融资", "creditcard.fill", details?.financingComplete == true),
            ("VIN", "key.fill", details?.vinAssigned == true),
            ("预约", "calendar.badge.checkmark", details?.appointment != nil),
        ]
    }

    var body: some View {
        HStack(alignment: .top, spacing: 4) {
            ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                VStack(spacing: 7) {
                    Image(systemName: step.1)
                        .font(.system(size: 15, weight: .semibold))
                        .frame(width: 36, height: 36)
                        .foregroundStyle(step.2 ? .white : .secondary)
                        .background(step.2 ? Color.blue : Color(uiColor: .tertiarySystemFill), in: Circle())
                    Text(step.0)
                        .font(.caption2.weight(step.2 ? .semibold : .regular))
                        .foregroundStyle(step.2 ? .primary : .secondary)
                }
                .frame(maxWidth: .infinity)
                if index < steps.count - 1 {
                    Rectangle()
                        .fill(step.2 && steps[index + 1].2 ? Color.blue : Color(uiColor: .separator))
                        .frame(height: 2)
                        .padding(.top, 17)
                        .frame(maxWidth: 22)
                }
            }
        }
    }
}

private struct DeliveryDetailsView: View {
    let details: DeliveryDetails

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("交付详情")
                .font(.caption.weight(.bold))
                .foregroundStyle(.secondary)

            if let method = details.deliveryMethod {
                DetailRow(icon: "shippingbox.fill", label: "方式", value: method.orderPulseDisplayCode, color: .blue)
            }
            if let center = details.deliveryCenter {
                DetailRow(icon: "mappin.and.ellipse", label: "地点", value: center, color: .red)
            }
            if let window = details.deliveryWindow {
                DetailRow(icon: "calendar", label: "预计窗口", value: window, color: .purple)
            }
            if let appointment = details.appointment {
                DetailRow(icon: "calendar.badge.checkmark", label: "交付预约", value: appointment, color: .green)
            }
            if let eta = details.etaToDeliveryCenter {
                DetailRow(icon: "truck.box.fill", label: "到店 ETA", value: DateText.display(eta), color: .orange)
            }
            if let location = details.vehicleLocation {
                DetailRow(icon: "location.fill", label: "车辆位置", value: location, color: .indigo)
            }
            if details.vinAssigned {
                DetailRow(icon: "key.fill", label: "VIN", value: details.vin ?? "已分配", color: .mint)
            }
            if let assigned = details.deliveryAgentAssigned {
                DetailRow(icon: "person.crop.circle.badge.checkmark", label: "交付顾问", value: assigned ? "已分配" : "尚未分配", color: .teal)
            }

            if !details.tasks.isEmpty {
                Divider()
                HStack {
                    Label("Tesla App 任务", systemImage: "checklist")
                        .font(.subheadline.weight(.semibold))
                    Spacer()
                    Text("\(details.pendingTaskCount) 项待完成")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                ForEach(details.tasks.prefix(8)) { task in
                    HStack(spacing: 10) {
                        Image(systemName: task.complete ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(task.complete ? .green : (task.enabled ? .blue : .secondary))
                        Text(task.title)
                            .font(.subheadline)
                            .foregroundStyle(task.enabled || task.complete ? .primary : .secondary)
                        Spacer()
                    }
                }
            }
        }
    }
}

private struct DetailRow: View {
    let icon: String
    let label: String
    let value: String
    let color: Color

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(color)
                .frame(width: 32, height: 32)
                .background(color.opacity(0.12), in: Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(value)
                    .font(.subheadline.weight(.medium))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
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
        case "configuration_changed": event.notificationEligible ? "交付信息更新" : "车辆配置更新"
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
                    LabeledContent("交付详情", value: model.bootstrap?.ownerAuthorized == true ? "已连接" : "尚未连接")
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
