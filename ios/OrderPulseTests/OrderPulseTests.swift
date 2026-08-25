import XCTest
@testable import OrderPulse

final class OrderPulseTests: XCTestCase {
    func testOrderUsesSubstatusAsPrimaryStatus() {
        let order = OrderSnapshot(
            orderId: "one",
            referenceNumber: "••••1234",
            orderStatus: "BOOKED",
            orderSubstatus: "AWAITING_VIN",
            modelCode: "MY",
            marketOptions: [],
            delivery: nil,
            firstSeenAt: nil,
            lastSeenAt: nil,
            lastChangedAt: nil,
            missingCount: 0,
            inactiveAt: nil
        )
        XCTAssertEqual(order.primaryStatus, "AWAITING_VIN")
        XCTAssertTrue(order.isActive)
    }

    func testBootstrapDecodesServerShape() throws {
        let data = Data(#"""
        {
          "serverTime":"2026-08-25T20:45:00.000Z",
          "apnsEnabled":false,
          "ownerAuthorized":true,
          "orders":[],
          "events":[],
          "polling":{"enabled":true,"inProgress":false,"nextPollAt":null,"latestRun":null}
        }
        """#.utf8)
        let response = try JSONDecoder().decode(BootstrapResponse.self, from: data)
        XCTAssertTrue(response.polling.enabled)
        XCTAssertFalse(response.apnsEnabled)
        XCTAssertEqual(response.ownerAuthorized, true)
    }
}
