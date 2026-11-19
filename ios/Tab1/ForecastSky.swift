import SwiftUI

/// Only the decorative canvas follows the animation clock. The forecast and its controls stay still.
struct ForecastSky: View {
  let weather: JSONValue
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.scenePhase) private var phase
  @State private var start = Date.now

  private var night: Bool { weather["isDay"] == .bool(false) }
  private var condition: String { weather["label"].string }
  private var openSky: Bool { ["Clear", "Mostly clear", "Partly cloudy"].contains(condition) }
  private var palette: [Color] {
    let stops: [Int]
    switch (night, condition) {
    case (true, "Thunderstorm"), (true, "Heavy rain"): stops = [0x07080d, 0x11131c, 0x1c1f2c]
    case (true, _) where openSky: stops = [0x070b17, 0x0e1830, 0x1c2b4a]
    case (true, _): stops = [0x0d1119, 0x19202c, 0x262f3e]
    case (_, "Clear"): stops = [0x16487c, 0x3377af, 0x679abd]
    case (_, "Mostly clear"), (_, "Partly cloudy"): stops = [0x24548a, 0x3a74ab, 0x6a93b8]
    case (_, "Fog"): stops = [0x4b545d, 0x646d75, 0x737b82]
    case (_, "Snow"): stops = [0x46566b, 0x5f6f85, 0x74839a]
    case (_, "Drizzle"): stops = [0x2e3b4a, 0x435265, 0x536276]
    case (_, "Rain"): stops = [0x232f3d, 0x34445a, 0x44556b]
    case (_, "Heavy rain"): stops = [0x19212c, 0x273343, 0x344255]
    case (_, "Thunderstorm"): stops = [0x15161f, 0x252636, 0x383649]
    default: stops = [0x3a434f, 0x535d6a, 0x66707c]
    }
    return stops.map { Color(red: Double($0 >> 16) / 255, green: Double(($0 >> 8) & 255) / 255,
                             blue: Double($0 & 255) / 255) }
  }

  var body: some View {
    ZStack {
      LinearGradient(colors: palette, startPoint: .topLeading, endPoint: .bottomTrailing)
      if openSky {
        RadialGradient(colors: [(night ? Color.white : .yellow).opacity(night ? 0.24 : 0.48), .clear],
                       center: UnitPoint(x: 0.9, y: 0.13), startRadius: 2, endRadius: night ? 135 : 225)
      }
      TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion || phase != .active || (condition == "Clear" && !night))) { clock in
        Canvas { context, size in
          let time = reduceMotion ? 0 : clock.date.timeIntervalSince(start)
          if openSky && night {
            for i in 0..<65 {
              let x = sample(i, 1) * size.width, y = sample(i, 2) * size.height * 0.72
              let radius = 0.6 + sample(i, 3) * 1.4
              context.fill(Path(ellipseIn: CGRect(x: x, y: y, width: radius, height: radius)),
                           with: .color(.white.opacity(0.5 + 0.24 * sin(time + Double(i)))))
            }
          }
          if condition != "Clear", let cloud = context.resolveSymbol(id: 0) {
            let fog = condition == "Fog"
            for i in 0..<(openSky ? 4 : 9) {
              let width = (fog ? 2 : 1) * (240 + sample(i, 3) * 360)
              let span = size.width + width
              let x = (sample(i, 2) * span + time * (4 + sample(i, 4) * 8)).truncatingRemainder(dividingBy: span) - width
              let y = size.height * sample(i, 6) * (fog ? 1 : 0.68) - 60
              context.opacity = night ? 0.18 : (openSky ? 0.7 : 0.4)
              context.draw(cloud, in: CGRect(x: x, y: y, width: width, height: fog ? 100 : width * 0.43))
            }
          }
          context.opacity = 1
          precipitation(context, size, time)
        } symbols: {
          // Rasterise one soft, irregular cloud bank and reuse it at different scales.
          ZStack {
            ForEach(0..<10) { i in
              Circle().fill(RadialGradient(colors: [.white.opacity(0.65), .white.opacity(0.24), .clear],
                center: .center, startRadius: 0, endRadius: 55))
                .frame(width: 110, height: 110)
                .offset(x: Double(i) * 18 - 81, y: 16 * cos(Double(i) * 0.64))
            }
          }.frame(width: 280, height: 150).tag(0)
        }
      }
      LinearGradient(colors: [.black.opacity(0.06), .black.opacity(0.3)],
                     startPoint: .topTrailing, endPoint: .bottomLeading)
    }.accessibilityHidden(true).allowsHitTesting(false)
  }

  private func sample(_ index: Int, _ salt: Int) -> Double {
    let hash = sin(Double(index * 131 + salt * 793)) * 43758.5453
    return hash - floor(hash)
  }

  private func precipitation(_ context: GraphicsContext, _ size: CGSize, _ time: Double) {
    let snow = condition == "Snow"
    let heavy = condition == "Heavy rain" || condition == "Thunderstorm"
    guard snow || heavy || condition == "Drizzle" || condition == "Rain" else { return }
    let drift = snow ? 0.05 : 0.15
    let speed = snow ? 33.0 : condition == "Drizzle" ? 210.0 : 440.0
    if condition == "Thunderstorm" {
      let pulse = max(0, 1 - abs(time.truncatingRemainder(dividingBy: 9) - 6) * 3)
      context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(.white.opacity(pulse * 0.23)))
    }
    for i in 0..<(heavy ? 155 : 85) {
      let depth = sample(i, 4)
      let y = (sample(i, 1) * size.height + time * speed * (0.6 + depth)).truncatingRemainder(dividingBy: size.height + 24)
      let x = (sample(i, 2) * size.width + y * drift + (snow ? sin(time * 0.7 + Double(i)) * 8 : 0) + size.width)
        .truncatingRemainder(dividingBy: size.width + 8) - 4
      if snow {
        let radius = 1 + depth * 3
        context.fill(Path(ellipseIn: CGRect(x: x, y: y, width: radius, height: radius)), with: .color(.white.opacity(0.65)))
      } else {
        let length = (heavy ? 20.0 : condition == "Drizzle" ? 6 : 13) * (0.5 + depth)
        var line = Path()
        line.move(to: CGPoint(x: x, y: y))
        line.addLine(to: CGPoint(x: x + length * drift, y: y + length))
        context.stroke(line, with: .color(.white.opacity(0.13 + depth * 0.18)), lineWidth: 0.8)
      }
    }
  }
}
