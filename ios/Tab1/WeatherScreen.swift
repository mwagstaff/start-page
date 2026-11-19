import SwiftUI

private func symbol(for forecast: JSONValue) -> String {
  let night = forecast["isDay"] == .bool(false)
  let label = forecast["label"].string
  if label.isEmpty, case .number(let code) = forecast["code"] {
    switch Int(code) {
    case 0: return night ? "moon.stars.fill" : "sun.max.fill"
    case 1, 2: return night ? "cloud.moon.fill" : "cloud.sun.fill"
    case 45, 48: return "cloud.fog.fill"
    case 51...57: return "cloud.drizzle.fill"
    case 71...77, 85, 86: return "cloud.snow.fill"
    case 61...67, 80...82: return "cloud.rain.fill"
    case 95...99: return "cloud.bolt.rain.fill"
    default: return "cloud.fill"
    }
  }
  switch label {
  case "Clear": return night ? "moon.stars.fill" : "sun.max.fill"
  case "Mostly clear", "Partly cloudy": return night ? "cloud.moon.fill" : "cloud.sun.fill"
  case "Fog": return "cloud.fog.fill"
  case "Drizzle": return "cloud.drizzle.fill"
  case "Rain", "Heavy rain": return "cloud.rain.fill"
  case "Snow": return "cloud.snow.fill"
  case "Thunderstorm": return "cloud.bolt.rain.fill"
  default: return "cloud.fill"
  }
}

struct ForecastScreen: View {
  @Environment(LibraryStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @Environment(\.dynamicTypeSize) private var typeSize
  @AppStorage("forecastFeelsLike") private var feels = false
  @State private var selectedDate: String?
  private var weather: JSONValue { store.library.weather }
  private var today: JSONValue { weather["today"] }
  private var days: [JSONValue] {
    weather["days"].array.filter {
      !$0["date"].string.isEmpty && $0["date"] != today["date"] && $0["label"].string != "Unknown"
    }
  }
  private var picked: JSONValue? { days.first { $0["date"].string == selectedDate } }
  private func degrees(_ row: JSONValue, _ key: String, apparent: Bool? = nil) -> String {
    let alternative = ["temperature": "feelsLike", "high": "feelsHigh", "low": "feelsLow"][key] ?? key
    let value = row[(apparent ?? feels) ? alternative : key]
    guard case .number(let n) = value else { return "—" }
    let fahrenheit = store.library.settings["temperature"].string == "F"
    return "\(Int((fahrenheit ? n * 9 / 5 + 32 : n).rounded()))°"
  }

  private func dateLabel(_ iso: String, long: Bool = false) -> String {
    let parts = iso.split(separator: "-").compactMap { Int($0) }
    let calendar = Calendar(identifier: .gregorian)
    guard parts.count == 3,
      let date = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12))
    else { return iso }
    return date.formatted(.dateTime.weekday(long ? .wide : .abbreviated).day().month(long ? .wide : .abbreviated))
  }

  var body: some View {
    ZStack {
      ForecastSky(weather: weather).ignoresSafeArea()
      VStack(spacing: 0) {
        controls
        if weather["temperature"] == .null && weather["label"].string.isEmpty {
          ContentUnavailableView("No saved forecast", systemImage: "cloud",
            description: Text("Weather will appear after the next successful update."))
        } else {
          ScrollView {
            VStack(alignment: .leading, spacing: 24) {
              hero
              if !days.isEmpty { daySelector }
              details
              if let updated = store.library.updated {
                Text("Forecast downloaded \(updated.formatted())").font(.caption).foregroundStyle(.white.opacity(0.83))
              }
            }
            .padding(.horizontal, 22).padding(.bottom, 28)
            .frame(maxWidth: 760, alignment: .leading).frame(maxWidth: .infinity)
          }
        }
      }
    }
    .foregroundStyle(.white)
    .tint(.white)
    .preferredColorScheme(.dark)
  }

  private var controls: some View {
    HStack {
      Menu {
        Picker("Temperature", selection: $feels) {
          Text("Regular").tag(false)
          Text("Feels like").tag(true)
        }
        Button("Use my location", systemImage: "location") { LocalWeather.shared.request() }
        Button("Use default location") { LocalWeather.shared.reset() }
      } label: {
        Label("Forecast options", systemImage: "slider.horizontal.3")
          .frame(width: 44, height: 44)
      }
      Spacer()
      Button { dismiss() } label: {
        Label("Done", systemImage: "xmark").frame(width: 44, height: 44)
      }
    }
    .labelStyle(.iconOnly)
    .buttonStyle(.glass)
    .buttonBorderShape(.circle)
    .padding(.horizontal, 20)
    .padding(.vertical, 8)
  }

  private var hero: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(weather["name"].string).font(.system(.title, design: .serif))
      Text(dateLabel(today["date"].string, long: true)).font(.subheadline).foregroundStyle(.white.opacity(0.83))
      Text(degrees(weather, "temperature"))
        .font(.system(size: typeSize.isAccessibilitySize ? 108 : 116, weight: .thin, design: .serif))
        .minimumScaleFactor(0.7).lineLimit(1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityLabel("\(feels ? "Feels like" : "Current temperature") \(degrees(weather, "temperature"))")
      Label(weather["label"].string, systemImage: symbol(for: weather))
        .font(.system(.title2, design: .serif).italic())
      Text("High \(degrees(weather, "high")) · Low \(degrees(weather, "low")) · \(feels ? "Regular" : "Feels like") \(degrees(weather, "temperature", apparent: !feels))")
        .font(.subheadline).foregroundStyle(.white.opacity(0.83))
    }
  }

  private var daySelector: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Daily forecast").font(.headline)
      ScrollView(.horizontal) {
        HStack(spacing: 7) {
          forecastButtons(days.filter { $0["date"].string < today["date"].string })
          dayButton("Today", row: weather, date: nil)
          forecastButtons(days.filter { $0["date"].string >= today["date"].string })
        }.padding(.vertical, 2)
      }.scrollIndicators(.hidden)
    }
  }

  private func forecastButtons(_ rows: [JSONValue]) -> some View {
    ForEach(rows, id: \.self) { day in
      dayButton(day["day"].string.isEmpty ? dateLabel(day["date"].string) : day["day"].string,
                row: day, date: day["date"].string)
    }
  }

  private func dayButton(_ title: String, row: JSONValue, date: String?) -> some View {
    let selected = date == picked?["date"].string
    return Button { selectedDate = date } label: {
      VStack(spacing: 8) {
        Text(title).font(.subheadline.weight(.semibold))
        Image(systemName: symbol(for: row)).font(.title3)
        Text("\(degrees(row, "high")) / \(degrees(row, "low"))").font(.caption)
      }
      .padding(.horizontal, 12).padding(.vertical, 12)
      .frame(minWidth: 78)
      .background(.white.opacity(selected ? 0.19 : 0.05), in: .rect(cornerRadius: 14))
      .overlay { RoundedRectangle(cornerRadius: 14).strokeBorder(.white.opacity(selected ? 0.72 : 0.13)) }
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(title), \(row["label"].string), high \(degrees(row, "high")), low \(degrees(row, "low"))")
    .accessibilityAddTraits(selected ? .isSelected : [])
  }

  private var details: some View {
    let day = picked ?? today
    let hours = picked == nil && day["hours"].array.isEmpty ? weather["hours"].array : day["hours"].array
    return VStack(alignment: .leading, spacing: 16) {
      Divider()
      Text(picked.map { dateLabel($0["date"].string, long: true) } ?? "Today’s outlook")
        .font(.system(.title2, design: .serif))
        .accessibilityAddTraits(.isHeader)
      if let picked {
        Text("\(picked["label"].string) · High \(degrees(picked, "high")) · Low \(degrees(picked, "low"))")
          .font(.subheadline)
      }
      LazyVGrid(columns: [GridItem(.adaptive(minimum: typeSize.isAccessibilitySize ? 155 : 94), alignment: .leading)], alignment: .leading, spacing: 14) {
        fact("Rain chance", value: (picked ?? weather)["rainChance"], suffix: "%")
        fact("Wind", value: day["wind"], suffix: " mph")
        fact("Humidity", value: day["humidity"], suffix: "%")
        fact("UV index", value: day["uv"])
        fact("Sunrise", value: day["sunrise"])
        fact("Sunset", value: day["sunset"])
      }
      let rainHours = picked == nil ? today["rainHours"].array : hours
      if rainHours.contains(where: { $0[picked == nil ? "mm" : "rain"] != .null }) {
        rainChart(rainHours, isToday: picked == nil)
      }
      if !hours.isEmpty {
        Text(picked == nil ? "Hours ahead" : "Hour by hour").font(.headline)
        ScrollView(.horizontal) {
          HStack(spacing: 20) {
            ForEach(Array(hours.enumerated()), id: \.offset) { _, hour in
              VStack(spacing: 8) {
                Text(hour["time"].string).font(.caption).foregroundStyle(.white.opacity(0.83))
                Image(systemName: symbol(for: hour))
                  .accessibilityLabel(hour["label"].string.isEmpty ? Text(Image(systemName: symbol(for: hour))) : Text(hour["label"].string))
                Text(degrees(hour, "temperature")).font(.subheadline.weight(.medium))
              }.accessibilityElement(children: .combine)
            }
          }
        }.id(selectedDate).scrollIndicators(.hidden)
      }
    }
  }

  private func rainChart(_ hours: [JSONValue], isToday: Bool) -> some View {
    let amount = isToday ? "mm" : "rain"
    let chance = isToday ? "chance" : "rainChance"
    let peak = hours.map { $0[amount].number }.max() ?? 0
    let summary = isToday ? weather["rain"]["summary"].string : ""
    return VStack(alignment: .leading, spacing: 6) {
      Text("Rain by hour").font(.headline)
      if !summary.isEmpty { Text(summary).font(.subheadline) }
      HStack(alignment: .bottom, spacing: 2) {
        ForEach(Array(hours.enumerated()), id: \.offset) { _, hour in
          ZStack(alignment: .bottom) {
            Rectangle().fill(.white.opacity(0.06 + 0.23 * hour[chance].number / 100))
            if hour[amount].number > 0 {
              Rectangle().fill(Color(red: 0.60, green: 0.85, blue: 1))
                .frame(height: max(2, 44 * hour[amount].number / max(2.5, peak)))
            }
          }
          .opacity(hour["past"] == .bool(true) ? 0.5 : 1)
          .accessibilityElement(children: .ignore)
          .accessibilityLabel("\(hour["time"].string), \(hour[amount].number.formatted()) millimetres, \(hour[chance].number.formatted()) percent chance")
        }
      }.frame(height: 44).clipShape(.rect(cornerRadius: 4))
      HStack {
        Text(hours.first?["time"].string ?? "")
        Spacer()
        Text("Amount · shading shows chance")
        Spacer()
        Text(hours.last?["time"].string ?? "")
      }.font(.caption2).foregroundStyle(.white.opacity(0.83))
    }
  }

  @ViewBuilder private func fact(_ name: String, value: JSONValue, suffix: String = "") -> some View {
    if value != .null {
      VStack(alignment: .leading, spacing: 3) {
        Text(name).font(.caption).foregroundStyle(.white.opacity(0.83))
        Text(value.string.isEmpty ? value.number.formatted() + suffix : value.string)
          .font(.body.weight(.medium))
      }.accessibilityElement(children: .combine)
    }
  }
}
