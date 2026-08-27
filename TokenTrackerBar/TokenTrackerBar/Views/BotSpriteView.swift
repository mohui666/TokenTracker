import SwiftUI

/// Renders the `bot` pet character from the pre-rendered clips in `BotFrames.json`.
///
/// The counterpart of `ClawdCompanionView` (hand-drawn pixel art) and
/// `PetAtlasSpriteView` (sprite sheets). Unlike those two it draws real vector
/// paths, so it stays crisp at any size — including the 18pt menu bar, which
/// `MenuBarBotFrameProvider` renders through the same geometry.
struct BotSpriteView: View {
    let state: String
    /// Stored colour preference: a palette id, or "auto" to follow the appearance.
    let colorId: String

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Display rate, independent of the clips' own sampling rate: consecutive frames
    /// are interpolated, so redrawing faster than the data genuinely looks smoother.
    /// 30 rather than 60 — this window is always on screen, and 30 already reads as
    /// fluid for exponential ease-outs.
    private static let displayFps: Double = 30

    /// Cross-fade bookkeeping. The clips each start from their own pose, so the morph
    /// between two states is done here by lerping their control points.
    ///
    /// `shown` tracks what is on screen because the deployment target is macOS 12,
    /// where `onChange` hands over only the new value.
    @State private var shown: String?
    @State private var fadingFrom: String?
    @State private var fadeStartedAt: Date?
    /// How far the outgoing clip had played when the state changed. The cross-fade
    /// starts from that frozen pose, which is what the engine itself does — blending
    /// from the previous clip's frame 0 would jump before it eased.
    @State private var fadingFromElapsed: TimeInterval = 0
    /// When the current clip started. Phase must be measured from here, not from the
    /// absolute clock: frame 0 is the state's morph-in (the generator builds a fresh
    /// engine per clip), so entering at a wall-clock-derived offset skips it and can
    /// wrap immediately.
    @State private var clipStartedAt = Date()

    private var engineState: String { BotFrames.engineState(forPetState: state) }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / Self.displayFps, paused: reduceMotion)) { context in
            Canvas(rendersAsynchronously: false) { ctx, canvasSize in
                draw(in: &ctx, side: min(canvasSize.width, canvasSize.height), now: context.date)
            }
        }
        .onAppear {
            shown = engineState
            clipStartedAt = Date()
        }
        .onChange(of: engineState) { next in
            let now = Date()
            if let shown, shown != next {
                fadingFrom = shown
                fadeStartedAt = now
                fadingFromElapsed = now.timeIntervalSince(clipStartedAt)
            }
            shown = next
            clipStartedAt = now
        }
        .accessibilityHidden(true)
    }

    private func frame(_ clip: BotFrames.Clip, at elapsed: TimeInterval) -> BotFrames.Frame? {
        guard !clip.frames.isEmpty else { return nil }
        let index = Int(max(0, elapsed * clip.fps).rounded(.down))
        let count = clip.frames.count
        return clip.loops ? clip.frames[wrap(index, count)] : clip.frames[min(index, count - 1)]
    }

    private func wrap(_ index: Int, _ count: Int) -> Int {
        ((index % count) + count) % count
    }

    /// The pair of stored frames surrounding `time`, plus how far between them it sits.
    ///
    /// This is where the smoothness comes from: every silhouette is sampled at the same
    /// 64 angles, so the two frames' point lists correspond one-to-one and the midpoint
    /// is a pairwise lerp. 12 fps of data therefore plays back at any display rate.
    private func span(_ clip: BotFrames.Clip, at elapsed: TimeInterval)
        -> (from: BotFrames.Frame, to: BotFrames.Frame, t: Double)? {
        guard !clip.frames.isEmpty else { return nil }
        let count = clip.frames.count
        let position = max(0, elapsed) * clip.fps
        let index = Int(position.rounded(.down))
        let fraction = position - position.rounded(.down)

        guard clip.loops else {
            // One-shot: settle on the last frame rather than whipping back to frame 0.
            if index >= count - 1 {
                let last = clip.frames[count - 1]
                return (last, last, 0)
            }
            return (clip.frames[index], clip.frames[index + 1], fraction)
        }
        return (clip.frames[wrap(index, count)], clip.frames[wrap(index + 1, count)], fraction)
    }

    private func draw(in ctx: inout GraphicsContext, side: CGFloat, now: Date) {
        guard let payload = BotFrames.payload,
              let clip = BotFrames.clip(engineState),
              let span = span(clip, at: now.timeIntervalSince(clipStartedAt))
        else { return }
        // Decoration (rings, particles) is read from the leading frame rather than
        // interpolated: their point counts change between frames, and they are
        // translucent, so a lerp would buy nothing for the extra bookkeeping.
        let current = span.from

        let transform = BotGeometry.viewTransform(side: side, halfViewBox: payload.halfViewBox)
        let ink = BotGeometry.color(
            hex: BotFrames.bodyHex(colorId: colorId, dark: colorScheme == .dark)
        )
        // The eye holes reveal whatever is behind the body, so they need an opaque
        // backing — otherwise the rings drawn behind the ball show up inside the eyes.
        // Colour comes from the shipped data so it matches the dashboard preview.
        let paper = BotGeometry.color(hex: BotFrames.paperHex(dark: colorScheme == .dark))

        // Interpolate within the clip, then blend out of the previous clip if a state
        // change is still morphing.
        var body = BotGeometry.blend(span.from.body, span.to.body, span.t)
        var bodyAlpha = BotGeometry.lerp(span.from.bodyAlpha, span.to.bodyAlpha, span.t)
        if let fadingFrom, let startedAt = fadeStartedAt, fadingFrom != engineState,
           let previousClip = BotFrames.clip(fadingFrom),
           let previousFrame = frame(previousClip, at: fadingFromElapsed) {
            let elapsed = now.timeIntervalSince(startedAt)
            if elapsed < clip.morph {
                // easeOutQuint, the engine's own transition curve.
                let k = min(1, max(0, elapsed / clip.morph))
                let eased = 1 - pow(1 - k, 5)
                body = BotGeometry.blend(previousFrame.body, body, eased)
                bodyAlpha = BotGeometry.lerp(previousFrame.bodyAlpha, bodyAlpha, eased)
            }
        }

        let bodyPath = BotGeometry.closedPath(points: body, transform: transform)

        for arc in current.arcs {
            stroke(&ctx, arc: arc, subpaths: arc.back, transform: transform)
        }
        if current.dotsBehind { drawDots(&ctx, current.dots, transform: transform, ink: ink) }

        ctx.opacity = bodyAlpha
        ctx.fill(bodyPath, with: .color(paper))
        // Eyes are holes punched in the body, not shapes laid on top.
        //
        // Punched with destination-out inside a layer, NOT an even-odd fill: on states
        // where the gaze swings wide (orbit sweeps +-65deg of yaw) an eye slides past
        // the silhouette, and even-odd renders that overhang as a solid spur instead of
        // clipping it. Destination-out only erases where the body was already drawn.
        var holes = Path()
        for (index, eye) in span.from.eyes.enumerated() {
            // Eye count is stable within a clip, so pair them up and interpolate the
            // capsule size, the transform and the fade — this is what makes a blink
            // and a sweeping gaze read as continuous rather than stepped.
            let next = index < span.to.eyes.count ? span.to.eyes[index] : eye
            let alpha = BotGeometry.lerp(eye.a, next.a, span.t)
            guard alpha > 0.01, let c = eye.c else { continue }
            let capsule = BotGeometry.blend(c, next.c ?? c, span.t)
            let matrix = BotGeometry.blend(eye.m ?? [], next.m ?? eye.m ?? [], span.t)
            holes.addPath(BotGeometry.capsulePath(
                capsule,
                transform: BotGeometry.matrix(matrix, viewTransform: transform)
            ))
        }
        if let notch = current.notch {
            holes.addPath(Path(ellipseIn: rect(for: notch, transform: transform)))
        }
        ctx.drawLayer { layer in
            layer.fill(bodyPath, with: .color(ink))
            if !holes.isEmpty {
                layer.blendMode = .destinationOut
                layer.fill(holes, with: .color(.black))
            }
        }
        ctx.opacity = 1

        if !current.dotsBehind { drawDots(&ctx, current.dots, transform: transform, ink: ink) }
        if let notif = current.notif {
            ctx.fill(Path(ellipseIn: rect(for: notif, transform: transform)), with: .color(BotGeometry.color(hex: "#2496e8")))
        }
        for arc in current.arcs {
            stroke(&ctx, arc: arc, subpaths: arc.front, transform: transform)
        }
    }

    private func rect(for circle: BotFrames.Circle, transform: CGAffineTransform) -> CGRect {
        let center = CGPoint(x: circle.x, y: circle.y).applying(transform)
        let radius = CGFloat(circle.r) * transform.a
        return CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)
    }

    private func stroke(
        _ ctx: inout GraphicsContext,
        arc: BotFrames.Arc,
        subpaths: [[Double]]?,
        transform: CGAffineTransform
    ) {
        guard let subpaths, arc.opacity > 0.01 else { return }
        ctx.opacity = arc.opacity
        let style = StrokeStyle(lineWidth: CGFloat(arc.width) * transform.a, lineCap: .round)
        let color = GraphicsContext.Shading.color(BotGeometry.color(hex: arc.color))
        for subpath in subpaths {
            ctx.stroke(BotGeometry.polylinePath(subpath, closed: false, transform: transform), with: color, style: style)
        }
        ctx.opacity = 1
    }

    private func drawDots(
        _ ctx: inout GraphicsContext,
        _ dots: [BotFrames.Dot],
        transform: CGAffineTransform,
        ink: Color
    ) {
        for dot in dots {
            let fill: Color
            if let hex = dot.color {
                fill = BotGeometry.color(hex: hex)
            } else if let depth = dot.depth {
                // Burst particles recede behind the core. The engine mixes toward the
                // paper colour; against that same paper, fading ink is equivalent.
                fill = ink.opacity(depth)
            } else {
                fill = ink
            }
            ctx.opacity = dot.opacity
            if let d = dot.d {
                // Shaped particle: positioned, rotated, then scaled by the ball radius.
                let radius = BotFrames.payload?.radius ?? 100
                var t = CGAffineTransform(scaleX: CGFloat(radius), y: CGFloat(radius))
                if let rot = dot.rot { t = t.concatenating(CGAffineTransform(rotationAngle: CGFloat(rot) * .pi / 180)) }
                t = t.concatenating(CGAffineTransform(translationX: CGFloat(dot.x), y: CGFloat(dot.y)))
                ctx.fill(
                    BotGeometry.polylinePath(d, closed: true, transform: t.concatenating(transform)),
                    with: .color(fill)
                )
            } else if let r = dot.r {
                ctx.fill(
                    Path(ellipseIn: rect(for: BotFrames.Circle(x: dot.x, y: dot.y, r: r), transform: transform)),
                    with: .color(fill)
                )
            }
            ctx.opacity = 1
        }
    }
}
