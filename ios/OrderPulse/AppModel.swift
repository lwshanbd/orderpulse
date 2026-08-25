import Combine
import Foundation
import UIKit
import UserNotifications

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var isPaired: Bool
    @Published private(set) var bootstrap: BootstrapResponse?
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?
    @Published private(set) var notificationStatus = "尚未启用"

    private let api = APIClient()
    private var accessToken: String?
    private var observers: [NSObjectProtocol] = []

    init() {
        accessToken = KeychainStore.loadAccessToken()
        isPaired = accessToken != nil
        observeRemoteNotificationRegistration()

        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--demo") {
            isPaired = true
            bootstrap = .demo
            notificationStatus = "演示模式"
            return
        }
        #endif

        if isPaired {
            Task {
                await refresh()
                await enableNotifications()
            }
        }
    }

    func pair(code: String, deviceName: String) async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let response = try await api.pair(code: code, deviceName: deviceName)
            try KeychainStore.saveAccessToken(response.accessToken)
            accessToken = response.accessToken
            isPaired = true
            bootstrap = try await api.bootstrap(accessToken: response.accessToken)
            await enableNotifications()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func refresh() async {
        guard let accessToken, !isLoading else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            bootstrap = try await api.bootstrap(accessToken: accessToken)
        } catch let error as APIError {
            if case .server(status: 401, code: _, message: _) = error {
                clearLocalPairing()
            }
            errorMessage = error.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func enableNotifications() async {
        guard accessToken != nil else { return }
        do {
            let granted = try await UNUserNotificationCenter.current().requestAuthorization(
                options: [.alert, .badge, .sound]
            )
            if granted {
                notificationStatus = "正在连接 APNs…"
                UIApplication.shared.registerForRemoteNotifications()
            } else {
                notificationStatus = "通知权限未开启"
            }
        } catch {
            notificationStatus = "通知授权失败"
        }
    }

    func unpair() async {
        if let accessToken {
            try? await api.revokeDevice(accessToken: accessToken)
        }
        clearLocalPairing()
    }

    private func clearLocalPairing() {
        KeychainStore.deleteAccessToken()
        accessToken = nil
        bootstrap = nil
        isPaired = false
        notificationStatus = "尚未启用"
    }

    private func observeRemoteNotificationRegistration() {
        observers.append(NotificationCenter.default.addObserver(
            forName: .orderPulseDidReceiveDeviceToken,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let token = notification.object as? String else { return }
            Task { @MainActor [weak self] in await self?.sendPushToken(token) }
        })
        observers.append(NotificationCenter.default.addObserver(
            forName: .orderPulseDidFailRemoteRegistration,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            let detail = notification.object as? String
            Task { @MainActor [weak self] in
                if detail?.contains("aps-environment") == true {
                    self?.notificationStatus = "当前安装包缺少推送签名；订单查询不受影响"
                } else {
                    self?.notificationStatus = detail.map { "APNs 注册失败：\($0)" } ?? "APNs 注册失败"
                }
            }
        })
    }

    private func sendPushToken(_ token: String) async {
        guard let accessToken else { return }
        do {
            #if DEBUG
            let environment = "sandbox"
            #else
            let environment = "production"
            #endif
            try await api.registerPushToken(token, environment: environment, accessToken: accessToken)
            notificationStatus = bootstrap?.apnsEnabled == true ? "提醒已连接" : "设备已注册，NAS 尚未启用 APNs"
        } catch {
            notificationStatus = "设备 token 上传失败"
        }
    }
}

#if DEBUG
extension BootstrapResponse {
    static let demo = BootstrapResponse(
        serverTime: "2026-08-25T20:45:00.000Z",
        apnsEnabled: true,
        orders: [
            OrderSnapshot(
                orderId: "demo",
                referenceNumber: "••••4821",
                orderStatus: "BOOKED",
                orderSubstatus: "AWAITING_VIN",
                modelCode: "MY",
                marketOptions: ["Pearl White", "19-inch Wheels"],
                firstSeenAt: "2026-08-24T14:00:00.000Z",
                lastSeenAt: "2026-08-25T20:30:00.000Z",
                lastChangedAt: "2026-08-25T18:10:00.000Z",
                missingCount: 0,
                inactiveAt: nil
            ),
        ],
        events: [
            OrderEvent(
                id: 2,
                orderId: "demo",
                referenceNumber: "••••4821",
                type: "status_changed",
                previousStatus: "BOOKED",
                previousSubstatus: "ORDER_CONFIRMED",
                currentStatus: "BOOKED",
                currentSubstatus: "AWAITING_VIN",
                notificationEligible: true,
                notificationDeliveredAt: "2026-08-25T18:10:02.000Z",
                createdAt: "2026-08-25T18:10:00.000Z"
            ),
        ],
        polling: PollingStatus(
            enabled: true,
            inProgress: false,
            nextPollAt: "2026-08-25T21:00:00.000Z",
            latestRun: PollRun(
                id: 12,
                source: "scheduled",
                outcome: "success",
                startedAt: "2026-08-25T20:30:00.000Z",
                finishedAt: "2026-08-25T20:30:01.000Z",
                orderCount: 1,
                eventCount: 0,
                errorCode: nil
            )
        )
    )
}
#endif
