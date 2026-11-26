import AuthenticationServices
import GoogleSignIn
import SwiftUI

private struct AccountStatus: Decodable {
  var providers: [String]
  var linked: [String]
  var googleClientId: String?
  var googleIOSId: String?
}
private struct AccountProof: Decodable {
  var chooseLayout: Bool
  var comparison: [String: [String]]?
  var suggestedChoice: String
  var proof: String
  var settings: JSONValue?
  var revision: Int?
}
struct AccountView: View {
  var compact = false
  @Environment(LibraryStore.self) private var store
  @State private var status: AccountStatus?
  @State private var appleNonce = ""
  @State private var working = false
  @State private var notice = ""
  @State private var proof: AccountProof?
  @State private var confirmDelete = false
  @State private var appleUser: String?

  var body: some View {
    Group {
      if compact {
        ViewThatFits(in: .vertical) {
          menuContent
          ScrollView { menuContent }
        }
        .frame(width: 264)
        .presentationCompactAdaptation(.popover)
      } else {
        Form {
          Section("Account") { actions }.disabled(working || proof != nil)
          layoutChoice
        }
      }
    }
      .navigationTitle("Account")
      .task { do { try await reload() } catch { notice = error.localizedDescription } }
      .confirmationDialog(
        "Permanently delete your account, saved homepage and reading activity?",
        isPresented: $confirmDelete
      ) {
        Button("Delete account", role: .destructive) { run { try await end("delete") } }
      }
  }
  private var menuContent: some View {
    VStack(alignment: .leading, spacing: 12) {
      if proof == nil {
        Text("Sign in or create an account").font(.headline)
        actions.disabled(working)
      } else {
        layoutChoice
      }
    }
    .buttonStyle(.bordered)
    .padding()
    .frame(maxWidth: .infinity, alignment: .leading)
  }
  @ViewBuilder private var actions: some View {
    if let status {
      if !compact {
        Text(status.linked.isEmpty
          ? "Sign in or create an account to sync your homepage, favourites and reading activity."
          : "Signed in with " + status.linked.map { $0.capitalized }.joined(separator: " and "))
      }
      if status.providers.isEmpty { Text("Account sign-in is currently unavailable.") }
      if status.providers.contains("apple") && !(status.linked.isEmpty && store.accountActive) {
        SignInWithAppleButton(.continue) { request in
          request.nonce = appleNonce
        } onCompletion: { result in
          run {
            guard
              let credential = try result.get().credential as? ASAuthorizationAppleIDCredential,
              let token = credential.identityToken, let code = credential.authorizationCode
            else { throw URLError(.userAuthenticationRequired) }
            appleUser = credential.user
            try await verify(
              appleNonce, String(decoding: token, as: UTF8.self),
              String(decoding: code, as: UTF8.self))
          }
        }.frame(height: 45).disabled(appleNonce.isEmpty).accessibilityIdentifier("account-apple")
        if status.linked.contains("apple") {
          Text("Continue with Apple to verify your account before linking or deleting.").font(
            .footnote)
        }
      }
      if status.providers.contains("google") && !(status.linked.isEmpty && store.accountActive)
      {
        let label = status.linked.contains("google") ? "Verify with Google"
          : status.linked.isEmpty ? "Continue with Google" : "Link Google"
        Button {
          run { try await google(status) }
        } label: {
          HStack(spacing: 10) {
            Image("GoogleMark").renderingMode(.original).resizable().scaledToFit()
              .frame(width: 20, height: 20).accessibilityHidden(true)
            Text(label).font(.body.weight(.medium))
          }
          .frame(maxWidth: .infinity).frame(height: 45)
          .foregroundStyle(.black).background(.white, in: RoundedRectangle(cornerRadius: 6))
          .overlay { RoundedRectangle(cornerRadius: 6).strokeBorder(.gray, lineWidth: 1) }
        }.buttonStyle(.plain)
      }
      if !status.linked.isEmpty {
        Button("Sign out") { run { try await end("signout") } }
        Button("Delete account", role: .destructive) { confirmDelete = true }
      }
    } else if notice.isEmpty {
      ProgressView()
    }
    if !notice.isEmpty {
      Text(notice)
      Button("Retry") { run { try await reload() } }
    }
    if working {
      HStack(alignment: .center, spacing: 8) {
        ProgressView().accessibilityHidden(true)
        Text("Updating account…")
      }
      .frame(maxWidth: .infinity, alignment: .center)
    }
  }
  @ViewBuilder private var layoutChoice: some View {
    if let proof {
      Section("Choose the homepage for all your devices") {
        Text("Favourites from both will be kept.")
        ForEach(["account", "local"], id: \.self) { choice in
          VStack(alignment: .leading, spacing: 6) {
            Text(choice == "account" ? "Saved homepage" : "This iPhone").font(.headline)
            ForEach(proof.comparison?[choice] ?? [], id: \.self) { detail in
              Text(detail).font(.subheadline)
            }
            Button(choice == "account" ? "Use saved homepage" : "Use this iPhone’s homepage") {
              run { try await finish(proof, choice) }
            }
          }
        }
        Button("Cancel", role: .cancel) { self.proof = nil }
      }.disabled(working)
    }
  }
  private func run(_ action: @escaping @MainActor () async throws -> Void) {
    guard !working else { return }
    working = true
    notice = ""
    Task { @MainActor in
      defer { working = false }
      do { try await action() } catch {
        proof = nil
        if !(error is CancellationError) { notice = error.localizedDescription }
        if let fresh = try? await nonce("apple") { appleNonce = fresh }
      }
    }
  }
  private func reload() async throws {
    guard store.server == "https://tab1.net" else { throw URLError(.unsupportedURL) }
    try await store.ensureProfile()
    let current: AccountStatus = try await store.request("account/status")
    if store.accountActive && current.linked.isEmpty {
      GIDSignIn.sharedInstance.signOut()
      await store.leaveAccount()
      try await store.ensureProfile()
    }
    status = current
    if current.providers.contains("apple") && !(current.linked.isEmpty && store.accountActive) {
      appleNonce = try await nonce("apple")
    }
  }
  private func nonce(_ provider: String) async throws -> String {
    let value: JSONValue = try await store.request(
      "account/challenge", body: .object(["provider": .string(provider)]))
    return value["nonce"].string
  }
  private func google(_ status: AccountStatus) async throws {
    guard let ios = status.googleIOSId, let web = status.googleClientId,
      let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first(
        where: { $0.activationState == .foregroundActive }),
      var presenter = scene.keyWindow?.rootViewController
    else { throw URLError(.cannotConnectToHost) }
    guard
      (Bundle.main.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]])?.contains(
        where: {
          ($0["CFBundleURLSchemes"] as? [String])?.contains(
            ios.components(separatedBy: ".").reversed().joined(separator: ".")) == true
        }) == true
    else {
      throw NSError(
        domain: "tab1", code: 1,
        userInfo: [NSLocalizedDescriptionKey: "This build needs the tab1 Google iOS client ID."])
    }
    while let next = presenter.presentedViewController { presenter = next }
    GIDSignIn.sharedInstance.configuration = GIDConfiguration(clientID: ios, serverClientID: web)
    let challenge = try await nonce("google")
    let result = try await GIDSignIn.sharedInstance.signIn(
      withPresenting: presenter, hint: nil, additionalScopes: nil, nonce: challenge)
    guard let token = result.user.idToken?.tokenString else {
      throw URLError(.userAuthenticationRequired)
    }
    appleUser = nil
    try await verify(challenge, token, "")
  }
  private func verify(_ nonce: String, _ token: String, _ code: String) async throws {
    try await store.sync()
    let value: AccountProof = try await store.request(
      "account/verify",
      body: .object([
        "nonce": .string(nonce), "idToken": .string(token), "code": .string(code),
        "settings": store.library.settings,
      ]))
    if value.chooseLayout { proof = value } else { try await finish(value, value.suggestedChoice) }
  }
  private func finish(_ value: AccountProof, _ choice: String) async throws {
    try await store.sync()
    let result: SyncResponse = try await store.request(
      "account/finish",
      body: .object([
        "proof": .string(value.proof), "choice": .string(choice),
        "settings": store.library.settings,
        "revision": value.revision.map { .number(Double($0)) } ?? .null,
      ]))
    try await store.adoptAccount(result, appleUser: appleUser)
    proof = nil
    if !compact { try await reload() }
  }
  private func end(_ action: String) async throws {
    if action == "signout" {
      try await store.signOut()
      try await reload()
      return
    }
    let _: JSONValue = try await store.request("account/" + action, body: .object([:]))
    GIDSignIn.sharedInstance.signOut()
    await store.leaveAccount(deleting: action == "delete")
    try await reload()
  }
}

extension LibraryStore {
  func signOut() async throws {
    guard accountActive, !endingSession else { return }
    endingSession = true
    defer { endingSession = false }
    if !library.pending.isEmpty || library.settings != library.baseline {
      do { try await sync() }
      catch let error as NSError where error.domain == "tab1" && error.code == 401 {
        // The server has already ended this session. Keep the offline account library.
      }
    }
    let _: JSONValue = try await request("account/signout", body: .object([:]))
    GIDSignIn.sharedInstance.signOut()
    await leaveAccount()
  }
}
