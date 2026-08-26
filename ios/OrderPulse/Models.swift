import Foundation

struct PairResponse: Decodable {
    let deviceId: String
    let accessToken: String
}

struct OwnerAuthorizationStartResponse: Decodable {
    let authorizationUrl: URL
}

struct BootstrapResponse: Decodable {
    let serverTime: String
    let apnsEnabled: Bool
    let ownerAuthorized: Bool?
    let orders: [OrderSnapshot]
    let events: [OrderEvent]
    let polling: PollingStatus
}

struct MobileRefreshResponse: Decodable {
    let polled: Bool
    let retryAfterSeconds: Int?
    let bootstrap: BootstrapResponse
}

struct OrderSnapshot: Decodable, Identifiable, Equatable {
    let orderId: String
    let referenceNumber: String?
    let orderStatus: String?
    let orderSubstatus: String?
    let modelCode: String?
    let marketOptions: [String]
    let delivery: DeliveryDetails?
    let firstSeenAt: String?
    let lastSeenAt: String?
    let lastChangedAt: String?
    let missingCount: Int
    let inactiveAt: String?

    var id: String { orderId }
    var primaryStatus: String { orderSubstatus ?? orderStatus ?? "等待 Tesla 更新" }
    var isActive: Bool { inactiveAt == nil }

    var modelName: String {
        switch modelCode?.uppercased() {
        case "S", "MS": "Model S"
        case "3", "M3": "Model 3"
        case "X", "MX": "Model X"
        case "Y", "MY": "Model Y"
        case "CT", "CYBERTRUCK": "Cybertruck"
        default: modelCode?.uppercased() ?? "Tesla"
        }
    }
}

struct DeliveryDetails: Decodable, Equatable {
    let vin: String?
    let vinAssigned: Bool
    let deliveryWindow: String?
    let appointment: String?
    let appointmentStatus: String?
    let appointmentValid: Bool?
    let rescheduleEligible: Bool?
    let deliveryEstimatesEnabled: Bool?
    let etaToDeliveryCenter: String?
    let vehicleLocation: String?
    let deliveryMethod: String?
    let deliveryCenter: String?
    let odometer: Double?
    let odometerUnit: String?
    let reservationDate: String?
    let orderBookedDate: String?
    let licensePlate: String?
    let financingComplete: Bool?
    let deliveryAgentAssigned: Bool?
    let pendingTaskCount: Int
    let totalTaskCount: Int
    let tasks: [OrderTaskSummary]

    var displayedVIN: String? { Self.concreteValue(vin) }
    var displayedAppointment: String? { Self.concreteValue(appointment) }
    var displayedAppointmentStatus: String? { Self.concreteValue(appointmentStatus) }
    var hasAssignedVIN: Bool { vinAssigned && displayedVIN != nil }
    var hasAppointment: Bool { displayedAppointment != nil }
    var vinDisplayText: String { displayedVIN ?? "尚未分配" }
    var appointmentDisplayText: String { displayedAppointment ?? "尚未安排" }

    private static func concreteValue(_ value: String?) -> String? {
        guard let value, !value.contains("##") else { return nil }
        return value
    }
}

struct OrderTaskSummary: Decodable, Identifiable, Equatable {
    let id: String
    let title: String
    let complete: Bool
    let enabled: Bool
    let required: Bool
    let order: Double?
}

struct OrderEvent: Decodable, Identifiable, Equatable {
    let id: Int
    let orderId: String
    let referenceNumber: String?
    let type: String
    let previousStatus: String?
    let previousSubstatus: String?
    let currentStatus: String?
    let currentSubstatus: String?
    let notificationEligible: Bool
    let notificationDeliveredAt: String?
    let createdAt: String?

    var previousValue: String? { previousSubstatus ?? previousStatus }
    var currentValue: String? { currentSubstatus ?? currentStatus }
}

struct PollingStatus: Decodable, Equatable {
    let enabled: Bool
    let inProgress: Bool
    let nextPollAt: String?
    let latestRun: PollRun?
}

struct PollRun: Decodable, Equatable {
    let id: Int
    let source: String
    let outcome: String
    let startedAt: String?
    let finishedAt: String?
    let orderCount: Int?
    let eventCount: Int?
    let errorCode: String?
}

struct APIErrorBody: Decodable {
    let error: String?
    let message: String?
}

enum DateText {
    static func display(_ value: String?) -> String {
        guard let value else { return "—" }
        let inputWithFraction = ISO8601DateFormatter()
        inputWithFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let input = ISO8601DateFormatter()
        guard let date = inputWithFraction.date(from: value) ?? input.date(from: value) else {
            return value
        }
        let output = DateFormatter()
        output.locale = Locale(identifier: "zh_CN")
        output.dateStyle = .medium
        output.timeStyle = .short
        return output.string(from: date)
    }
}

extension String {
    var orderPulseDisplayCode: String {
        replacingOccurrences(of: "_", with: " ").localizedCapitalized
    }
}
