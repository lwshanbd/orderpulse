import AuthenticationServices
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
    @Published private(set) var isConnectingOwner = false

    private let api = APIClient()
    private var accessToken: String?
    private var observers: [NSObjectProtocol] = []
    private var ownerAuthenticationSession: ASWebAuthenticationSession?
    private let ownerAuthenticationContext = OwnerAuthenticationContext()

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
            guard !Self.isCancellation(error) else { return }
            errorMessage = error.localizedDescription
        }
    }

    nonisolated static func isCancellation(_ error: Error) -> Bool {
        error is CancellationError || (error as? URLError)?.code == .cancelled
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

    func connectOwnerAuthorization() async {
        guard let accessToken, !isConnectingOwner else { return }
        isConnectingOwner = true
        errorMessage = nil
        do {
            let response = try await api.beginOwnerAuthorization(accessToken: accessToken)
            let session = ASWebAuthenticationSession(
                url: response.authorizationUrl,
                callbackURLScheme: "tesla"
            ) { [weak self] callbackURL, error in
                Task { @MainActor [weak self] in
                    await self?.finishOwnerAuthorization(callbackURL: callbackURL, error: error)
                }
            }
            session.presentationContextProvider = ownerAuthenticationContext
            session.prefersEphemeralWebBrowserSession = false
            ownerAuthenticationSession = session
            if !session.start() {
                ownerAuthenticationSession = nil
                isConnectingOwner = false
                errorMessage = "无法打开 Tesla 登录页面。"
            }
        } catch {
            isConnectingOwner = false
            errorMessage = error.localizedDescription
        }
    }

    func unpair() async {
        if let accessToken {
            try? await api.revokeDevice(accessToken: accessToken)
        }
        clearLocalPairing()
    }

    private func clearLocalPairing() {
        ownerAuthenticationSession?.cancel()
        ownerAuthenticationSession = nil
        isConnectingOwner = false
        KeychainStore.deleteAccessToken()
        accessToken = nil
        bootstrap = nil
        isPaired = false
        notificationStatus = "尚未启用"
    }

    private func finishOwnerAuthorization(callbackURL: URL?, error: Error?) async {
        ownerAuthenticationSession = nil
        defer { isConnectingOwner = false }
        if let authenticationError = error as? ASWebAuthenticationSessionError,
           authenticationError.code == .canceledLogin {
            return
        }
        guard let accessToken, let callbackURL else {
            errorMessage = error?.localizedDescription ?? "Tesla 登录没有返回授权结果。"
            return
        }
        do {
            try await api.completeOwnerAuthorization(
                callbackURL: callbackURL,
                accessToken: accessToken
            )
            bootstrap = try await api.bootstrap(accessToken: accessToken)
        } catch {
            errorMessage = error.localizedDescription
        }
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

@MainActor
private final class OwnerAuthenticationContext: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow) ?? UIWindow()
    }
}

#if DEBUG
extension BootstrapResponse {
    static let demo = BootstrapResponse(
        serverTime: "2026-08-25T20:45:00.000Z",
        apnsEnabled: true,
        ownerAuthorized: true,
        orders: [
            OrderSnapshot(
                orderId: "demo",
                referenceNumber: "••••4821",
                orderStatus: "BOOKED",
                orderSubstatus: "AWAITING_VIN",
                modelCode: "MY",
                marketOptions: ["Pearl White", "19-inch Wheels"],
                delivery: DeliveryDetails(
                    vin: nil,
                    vinAssigned: false,
                    deliveryWindow: "September 13 – September 30",
                    appointment: nil,
                    appointmentStatus: nil,
                    appointmentValid: nil,
                    rescheduleEligible: nil,
                    deliveryEstimatesEnabled: true,
                    etaToDeliveryCenter: nil,
                    vehicleLocation: nil,
                    deliveryMethod: "PICKUP_SERVICE_CENTER",
                    deliveryCenter: "Smithtown",
                    odometer: nil,
                    odometerUnit: nil,
                    reservationDate: "2026-08-24T14:00:00.000Z",
                    orderBookedDate: "2026-08-24T14:00:00.000Z",
                    licensePlate: nil,
                    financingComplete: true,
                    deliveryAgentAssigned: true,
                    pendingTaskCount: 1,
                    totalTaskCount: 3,
                    tasks: [
                        OrderTaskSummary(id: "registration", title: "Registration", complete: true, enabled: true, required: true, order: 1),
                        OrderTaskSummary(id: "finance", title: "Financing", complete: true, enabled: true, required: true, order: 2),
                        OrderTaskSummary(id: "insurance", title: "Insurance", complete: false, enabled: true, required: true, order: 3),
                    ]
                ),
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
