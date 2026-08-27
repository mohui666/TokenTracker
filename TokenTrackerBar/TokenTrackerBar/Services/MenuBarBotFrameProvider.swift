import AppKit
import SwiftUI

/// Renders the `bot` character into menu bar template images.
///
/// Simpler than `MenuBarPetFrameProvider`, its atlas counterpart: a sprite sheet has to
/// be thresholded by luma to become a silhouette, while `bot` already *is* one — a
/// filled body with the eyes punched out. Even-odd filling the body plus the eye
/// paths gives the exact alpha mask a template image wants, with no heuristics.
@MainActor
final class MenuBarBotFrameProvider {
    struct FrameSet {
        let idle: [NSImage]
        let active: [NSImage]
        let sleeping: [NSImage]
        let disconnected: [NSImage]
    }

    /// Canvas matches the Clawd icon so the composite stats image lays them out
    /// identically (see `makeDisplayMenuBarImage`).
    static let canvasSize = NSSize(width: 22, height: 22)
    /// Painted diameter of the resting ball, in points. The viewBox is 316 units wide
    /// while the ball is 200, so the box is scaled past the canvas and the surplus —
    /// orbit-ring headroom, invisible at this size — is allowed to clip.
    private static let ballDiameter: CGFloat = 16

    /// The animator's four tiers. Which engine clip each one plays is decided in
    /// `BOT_MENUBAR_CLIPS` (dashboard/src/lib/bot-appearance.js) and shipped in the
    /// frame data, so the choice lives in one place rather than being retyped here.
    private static let tiers = ["idle", "active", "sleeping", "disconnected"]

    private var cache: FrameSet?

    /// Nil when the pre-rendered frames are missing, so the animator can fall back.
    func frames() -> FrameSet? {
        if let cache { return cache }
        guard BotFrames.isAvailable else { return nil }
        var rendered: [String: [NSImage]] = [:]
        for tier in Self.tiers {
            rendered[tier] = Self.render(engineState: BotFrames.menubarClip(tier))
        }
        guard let idle = rendered["idle"], !idle.isEmpty else { return nil }
        let set = FrameSet(
            idle: idle,
            active: rendered["active"] ?? idle,
            sleeping: rendered["sleeping"] ?? idle,
            disconnected: rendered["disconnected"] ?? idle
        )
        cache = set
        return set
    }

    private static func render(engineState: String) -> [NSImage] {
        guard let payload = BotFrames.payload, let clip = BotFrames.clip(engineState)
        else { return [] }
        return clip.frames.map { frame in image(frame, halfViewBox: payload.halfViewBox) }
    }

    private static func image(_ frame: BotFrames.Frame, halfViewBox: Double) -> NSImage {
        // Scale the viewBox so the ball lands at `ballDiameter`, then centre it.
        let side = canvasSize.width * (CGFloat(halfViewBox * 2) / 200) * (ballDiameter / canvasSize.width)
        let transform = BotGeometry.viewTransform(side: side, halfViewBox: halfViewBox)
            .concatenating(CGAffineTransform(
                translationX: (canvasSize.width - side) / 2,
                y: (canvasSize.height - side) / 2
            ))

        let body = BotGeometry.closedPath(points: frame.body, transform: transform)
        var holes = Path()
        for eye in frame.eyes where eye.a > 0.5 {
            guard let c = eye.c else { continue }
            holes.addPath(BotGeometry.capsulePath(c, transform: BotGeometry.matrix(eye.m, viewTransform: transform)))
        }
        if let notch = frame.notch {
            holes.addPath(circlePath(notch, transform: transform))
        }

        // Solid dots only: a template image carries alpha, so the engine's depth and
        // opacity fades would read as noise rather than distance at 22pt. Shape is kept
        // though — `alert`, the disconnected clip, has ONLY shaped particles, so
        // skipping those left that animation as a bare body morph.
        var extras = Path()
        for dot in frame.dots where dot.opacity > 0.5 {
            if let r = dot.r {
                extras.addPath(circlePath(BotFrames.Circle(x: dot.x, y: dot.y, r: r), transform: transform))
            } else if let d = dot.d {
                extras.addPath(BotGeometry.polylinePath(
                    d,
                    closed: true,
                    transform: Self.dotTransform(dot, viewTransform: transform)
                ))
            }
        }
        if let notif = frame.notif {
            extras.addPath(circlePath(notif, transform: transform))
        }

        let image = NSImage(size: canvasSize, flipped: true) { _ in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return true }
            ctx.setFillColor(NSColor.black.cgColor)
            ctx.addPath(body.cgPath)
            ctx.fillPath()
            if !holes.isEmpty {
                // Clear rather than even-odd: an eye that slides past the silhouette
                // (orbit swings the gaze wide) would otherwise fill as a solid spur.
                // Clearing only removes alpha the body actually laid down.
                ctx.setBlendMode(.clear)
                ctx.addPath(holes.cgPath)
                ctx.fillPath()
                ctx.setBlendMode(.normal)
            }
            if !extras.isEmpty {
                ctx.addPath(extras.cgPath)
                ctx.fillPath(using: .winding)
            }
            return true
        }
        // Template: AppKit tints it for the current menu bar appearance.
        image.isTemplate = true
        return image
    }

    /// Shaped particles are authored in ball-radius units, then positioned and rotated.
    private static func dotTransform(_ dot: BotFrames.Dot, viewTransform: CGAffineTransform) -> CGAffineTransform {
        let radius = BotFrames.payload?.radius ?? 100
        var t = CGAffineTransform(scaleX: CGFloat(radius), y: CGFloat(radius))
        if let rot = dot.rot {
            t = t.concatenating(CGAffineTransform(rotationAngle: CGFloat(rot) * .pi / 180))
        }
        return t
            .concatenating(CGAffineTransform(translationX: CGFloat(dot.x), y: CGFloat(dot.y)))
            .concatenating(viewTransform)
    }

    private static func circlePath(_ circle: BotFrames.Circle, transform: CGAffineTransform) -> Path {
        let center = CGPoint(x: circle.x, y: circle.y).applying(transform)
        let radius = CGFloat(circle.r) * transform.a
        return Path(ellipseIn: CGRect(
            x: center.x - radius,
            y: center.y - radius,
            width: radius * 2,
            height: radius * 2
        ))
    }
}
