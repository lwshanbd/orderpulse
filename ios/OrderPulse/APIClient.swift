import Foundation

struct APIClient {
    static let defaultBaseURL = URL(string: "https://orderpulse.baodishan.com")!

    let baseURL: URL
    private let session: URLSession
    private let decoder = JSONDecoder()

    init(baseURL: URL = defaultBaseURL) {
        self.baseURL = baseURL
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 30
        configuration.waitsForConnectivity = true
        session = URLSession(configuration: configuration)
    }

    func pair(code: String, deviceName: String) async throws -> PairResponse {
        try await request(
            path: "/api/mobile/pair",
            method: "POST",
            body: ["code": code, "name": deviceName],
            accessToken: nil,
            response: PairResponse.self
        )
    }

    func bootstrap(accessToken: String) async throws -> BootstrapResponse {
        try await request(
            path: "/api/mobile/bootstrap",
            method: "GET",
            body: Optional<[String: String]>.none,
            accessToken: accessToken,
            response: BootstrapResponse.self
        )
    }

    func beginOwnerAuthorization(accessToken: String) async throws -> OwnerAuthorizationStartResponse {
        try await request(
            path: "/api/mobile/owner-authorization/start",
            method: "POST",
            body: Optional<[String: String]>.none,
            accessToken: accessToken,
            response: OwnerAuthorizationStartResponse.self
        )
    }

    func completeOwnerAuthorization(callbackURL: URL, accessToken: String) async throws {
        try await requestWithoutResponse(
            path: "/api/mobile/owner-authorization/complete",
            method: "POST",
            body: ["callbackUrl": callbackURL.absoluteString],
            accessToken: accessToken
        )
    }

    func registerPushToken(_ token: String, environment: String, accessToken: String) async throws {
        try await requestWithoutResponse(
            path: "/api/mobile/device-token",
            method: "PUT",
            body: ["token": token, "environment": environment],
            accessToken: accessToken
        )
    }

    func revokeDevice(accessToken: String) async throws {
        try await requestWithoutResponse(
            path: "/api/mobile/device",
            method: "DELETE",
            body: Optional<[String: String]>.none,
            accessToken: accessToken
        )
    }

    private func request<Body: Encodable, Response: Decodable>(
        path: String,
        method: String,
        body: Body?,
        accessToken: String?,
        response: Response.Type
    ) async throws -> Response {
        let (data, httpResponse) = try await perform(
            path: path,
            method: method,
            body: body,
            accessToken: accessToken
        )
        try validate(httpResponse, data: data)
        return try decoder.decode(Response.self, from: data)
    }

    private func requestWithoutResponse<Body: Encodable>(
        path: String,
        method: String,
        body: Body?,
        accessToken: String
    ) async throws {
        let (data, response) = try await perform(
            path: path,
            method: method,
            body: body,
            accessToken: accessToken
        )
        try validate(response, data: data)
    }

    private func perform<Body: Encodable>(
        path: String,
        method: String,
        body: Body?,
        accessToken: String?
    ) async throws -> (Data, HTTPURLResponse) {
        guard let url = URL(string: path, relativeTo: baseURL) else { throw APIError.invalidURL }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let accessToken {
            request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        return (data, httpResponse)
    }

    private func validate(_ response: HTTPURLResponse, data: Data) throws {
        guard !(200...299).contains(response.statusCode) else { return }
        let errorBody = try? decoder.decode(APIErrorBody.self, from: data)
        throw APIError.server(
            status: response.statusCode,
            code: errorBody?.error,
            message: errorBody?.message
        )
    }
}

enum APIError: LocalizedError {
    case invalidURL
    case invalidResponse
    case server(status: Int, code: String?, message: String?)

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "后台地址无效。"
        case .invalidResponse: return "后台返回了无法识别的响应。"
        case .server(let status, let code, let message):
            if status == 401 { return "设备配对已失效，请重新配对。" }
            if code == "invalid_or_expired_pairing_code" { return "配对码错误或已经过期。" }
            if code == "too_many_pairing_attempts" { return "尝试次数过多，请稍后再试。" }
            if code == "owner_already_authorized" { return "Tesla 订单详情已经连接。" }
            if code == "owner_authorization_failed" { return "Tesla 登录回调无效或已经过期，请重新开始。" }
            return message ?? "后台请求失败（\(status)）。"
        }
    }
}
