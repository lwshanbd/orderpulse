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

    func testOwnerAuthorizationStartDecodesTeslaCallbackScheme() throws {
        let data = Data(#"{"authorizationUrl":"https://auth.tesla.com/oauth2/v3/authorize?redirect_uri=tesla%3A%2F%2Fauth%2Fcallback"}"#.utf8)
        let response = try JSONDecoder().decode(OwnerAuthorizationStartResponse.self, from: data)
        let components = URLComponents(url: response.authorizationUrl, resolvingAgainstBaseURL: false)
        let redirect = components?.queryItems?.first(where: { $0.name == "redirect_uri" })?.value
        XCTAssertEqual(redirect, "tesla://auth/callback")
    }

    func testRefreshCancellationIsNotPresentedAsAnError() {
        XCTAssertTrue(AppModel.isCancellation(CancellationError()))
        XCTAssertTrue(AppModel.isCancellation(URLError(.cancelled)))
        XCTAssertFalse(AppModel.isCancellation(URLError(.timedOut)))
    }

    func testTeslaTemplateValuesAreNotDisplayedAsRealProgress() throws {
        let data = Data(#"""
        {
          "vin":"•••••#vin##",
          "vinAssigned":true,
          "appointment":"##date## between ##startTime## - ##endTime##",
          "pendingTaskCount":0,
          "totalTaskCount":0,
          "tasks":[]
        }
        """#.utf8)
        let details = try JSONDecoder().decode(DeliveryDetails.self, from: data)
        XCTAssertNil(details.displayedVIN)
        XCTAssertNil(details.displayedAppointment)
        XCTAssertFalse(details.hasAssignedVIN)
        XCTAssertFalse(details.hasAppointment)
    }
}
