import Foundation
import SwiftUI

/// Pre-rendered animation frames for the `bot` pet character.
///
/// The engine itself lives in `dashboard/src/lib/bot/` and never runs here: it is a
/// pure function of time, so `scripts/gen-bot-frames.cjs` samples it at build time
/// and we ship `BotFrames.json`. That keeps the engine as the single source of truth
/// instead of hand-mirroring ~1900 lines of pose logic into Swift — the duplication
/// this character was adopted to remove.
///
/// Re-run `npm run gen:bot-frames` after touching the engine or the state mapping.
enum BotFrames {
    /// Bump in lockstep with `schema` in the generator.
    static let expectedSchema = 4

    struct Payload: Decodable {
        let schema: Int
        let radius: Double
        let halfViewBox: Double
        /// Our pet-state vocabulary -> engine state id. Shipped rather than mirrored
        /// here, so `lib/bot-appearance.js` stays the only place the mapping lives.
        let scenes: [String: String]
        /// The menu bar's own four-state vocabulary -> engine state id.
        let menubarClips: [String: String]
        /// What the eye holes reveal, per appearance. Shared with the web renderer.
        let paper: AutoColors
        /// Pickable body colours, id -> hex. Shipped from the engine's skins.ts.
        let palette: [String: String]
        /// What "auto" resolves to per appearance, so the silhouette never sinks
        /// into its own background.
        let autoColors: AutoColors
        let states: [String: Clip]
    }

    struct AutoColors: Decodable {
        let light: String
        let dark: String
    }

    struct Clip: Decodable {
        /// Sampling rate of THIS clip. The menu bar clips are denser because the
        /// menu bar plays images and cannot interpolate; see gen-bot-frames.cjs.
        let fps: Double
        /// False for clips whose first and last frames are far apart — upstream plays
        /// them once, not on repeat. Those hold their last frame instead of wrapping,
        /// which is also what the web renderer ends up doing.
        let loops: Bool
        /// Distance between first and last frame, in viewBox units. Diagnostic.
        let seam: Double?
        let duration: Double
        /// Engine morph-in duration, reused as the cross-fade length between clips.
        let morph: Double
        let baseFace: Bool
        let frames: [Frame]
    }

    struct Frame: Decodable {
        /// 64 on-curve points, flattened x,y. Control points are recomputed — see `path(in:)`.
        let body: [Double]
        let bodyAlpha: Double
        let eyes: [Eye]
        let dots: [Dot]
        let dotsBehind: Bool
        let arcs: [Arc]
        let notif: Circle?
        let notch: Circle?
    }

    struct Eye: Decodable {
        /// Capsule as [halfWidth, halfHeight, cornerRadius] — the eyes are arc
        /// capsules, not radial profiles, so they ship as dimensions instead of a path.
        let c: [Double]?
        /// SVG matrix(a,b,c,d,e,f).
        let m: [Double]?
        let a: Double
    }

    struct Dot: Decodable {
        let x: Double
        let y: Double
        let r: Double?
        /// Closed polyline, flattened x,y (shaped burst particles).
        let d: [Double]?
        let rot: Double?
        /// 0…1 blend from paper toward ink, for burst particles receding behind the core.
        let depth: Double?
        let color: String?
        let opacity: Double
    }

    struct Arc: Decodable {
        /// OPEN polylines per subpath, each flattened x,y. Stroked, so they must not
        /// be closed — and they arrive as SEPARATE subpaths because the body breaks a
        /// ring in two; joining them draws a line across the whole figure.
        let back: [[Double]]?
        let front: [[Double]]?
        let width: Double
        let opacity: Double
        /// Mid stop of the engine's gradient: macOS strokes the rings in one flat colour.
        let color: String
    }

    struct Circle: Decodable {
        let x: Double
        let y: Double
        let r: Double
    }

    /// Loaded once; the file is ~470 KB of JSON so it is decoded lazily on first use.
    static let payload: Payload? = {
        guard let url = Bundle.main.url(forResource: "BotFrames", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder().decode(Payload.self, from: data)
        else { return nil }
        guard decoded.schema == expectedSchema else { return nil }
        return decoded
    }()

    static var isAvailable: Bool { payload != nil }

    static func clip(_ state: String) -> Clip? {
        guard let payload else { return nil }
        return payload.states[state] ?? payload.states["idle"]
    }

    /// Engine state for one of the menu bar's four tiers.
    static func menubarClip(_ tier: String) -> String {
        payload?.menubarClips[tier] ?? "idle"
    }

    /// Eye-white colour, matching BOT_PAPER in lib/bot-appearance.js.
    static func paperHex(dark: Bool) -> String {
        guard let payload else { return dark ? "#0f172a" : "#f8fafc" }
        return dark ? payload.paper.dark : payload.paper.light
    }

    /// Body colour for a stored preference. "auto" — and anything stale, such as a
    /// colour dropped from the picker — follows the appearance.
    static func bodyHex(colorId: String, dark: Bool) -> String {
        guard let payload else { return dark ? "#f1efe9" : "#0a0a0c" }
        if let hex = payload.palette[colorId] { return hex }
        return dark ? payload.autoColors.dark : payload.autoColors.light
    }

    /// Resolve one of our pet states (`working-typing`, `sleeping`, …) to an engine
    /// state id. Unknown states fall back to idle: the hosts and pet packages push
    /// names we do not control.
    static func engineState(forPetState petState: String) -> String {
        payload?.scenes[petState] ?? "idle"
    }
}

// MARK: - Geometry

/// The only engine math that is ported rather than pre-rendered.
///
/// All silhouettes are sampled at the same 64 angles, so two frames' point lists
/// correspond one-to-one and morphing is a plain pairwise lerp. `closedPath` derives
/// each cubic's control points from the neighbouring points (Catmull-Rom, tension
/// 1/6), which is why the generator only ships the on-curve points.
enum BotGeometry {
    static let tension = 1.0 / 6.0

    static func lerp(_ a: Double, _ b: Double, _ t: Double) -> Double { a + (b - a) * t }

    /// Pairwise interpolation of two equal-length flat number lists.
    /// Returns `to` unchanged when the lengths disagree — different shapes (an eye
    /// capsule vs a burst particle) must never be blended into nonsense.
    static func blend(_ from: [Double], _ to: [Double], _ t: Double) -> [Double] {
        guard from.count == to.count else { return to }
        if t <= 0 { return from }
        if t >= 1 { return to }
        var out = [Double](repeating: 0, count: to.count)
        for i in 0..<to.count { out[i] = lerp(from[i], to[i], t) }
        return out
    }

    /// Flat x,y list of on-curve points -> closed cubic path, control points derived.
    static func closedPath(points flat: [Double], transform: CGAffineTransform) -> Path {
        var path = Path()
        let count = flat.count / 2
        guard count >= 3 else { return path }
        func point(_ i: Int) -> CGPoint {
            let index = ((i % count) + count) % count
            return CGPoint(x: flat[index * 2], y: flat[index * 2 + 1]).applying(transform)
        }
        path.move(to: point(0))
        for i in 0..<count {
            let p0 = point(i - 1), p1 = point(i), p2 = point(i + 1), p3 = point(i + 2)
            path.addCurve(
                to: p2,
                control1: CGPoint(x: p1.x + (p2.x - p0.x) * tension, y: p1.y + (p2.y - p0.y) * tension),
                control2: CGPoint(x: p2.x - (p3.x - p1.x) * tension, y: p2.y - (p3.y - p1.y) * tension)
            )
        }
        path.closeSubpath()
        return path
    }

    /// Flat x,y list -> polyline. The orbit rings and comet ribbons are stroked and
    /// must stay OPEN; the shaped burst particles are filled and closed.
    static func polylinePath(_ flat: [Double], closed: Bool, transform: CGAffineTransform) -> Path {
        var path = Path()
        guard flat.count >= 4 else { return path }
        path.move(to: CGPoint(x: flat[0], y: flat[1]).applying(transform))
        var i = 2
        while i + 1 < flat.count {
            path.addLine(to: CGPoint(x: flat[i], y: flat[i + 1]).applying(transform))
            i += 2
        }
        if closed { path.closeSubpath() }
        return path
    }

    /// Eye capsule from [halfWidth, halfHeight, cornerRadius], centred on the origin.
    /// A rounded rect reproduces the engine's arc capsule exactly, because its corner
    /// radius is always min(halfWidth, halfHeight) — i.e. a true stadium shape.
    static func capsulePath(_ c: [Double], transform: CGAffineTransform) -> Path {
        guard c.count >= 3 else { return Path() }
        let rect = CGRect(x: -c[0], y: -c[1], width: c[0] * 2, height: c[1] * 2)
        return Path(roundedRect: rect, cornerRadius: c[2]).applying(transform)
    }

    /// SVG `matrix(a,b,c,d,e,f)` in the engine's own units, composed with the view transform.
    static func matrix(_ m: [Double]?, viewTransform: CGAffineTransform) -> CGAffineTransform {
        guard let m, m.count >= 6 else { return viewTransform }
        return CGAffineTransform(a: m[0], b: m[1], c: m[2], d: m[3], tx: m[4], ty: m[5])
            .concatenating(viewTransform)
    }

    /// viewBox (-half…+half, y down) -> a square of `side` points, y still down.
    static func viewTransform(side: CGFloat, halfViewBox: Double) -> CGAffineTransform {
        let scale = side / CGFloat(halfViewBox * 2)
        return CGAffineTransform(translationX: CGFloat(halfViewBox), y: CGFloat(halfViewBox))
            .concatenating(CGAffineTransform(scaleX: scale, y: scale))
    }

    static func color(hex: String) -> Color {
        var value = hex.trimmingCharacters(in: .whitespaces)
        if value.hasPrefix("#") { value.removeFirst() }
        guard value.count == 6, let int = UInt32(value, radix: 16) else { return .primary }
        return Color(
            red: Double((int >> 16) & 0xFF) / 255,
            green: Double((int >> 8) & 0xFF) / 255,
            blue: Double(int & 0xFF) / 255
        )
    }
}
