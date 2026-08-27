import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  BOT_COLOR_CHOICES,
  BOT_DEFAULT_SHAPE,
  botMappedPetStates,
  botReachableStates,
  botSceneForPetState,
  resolveBotColor,
} from "../../lib/bot-appearance.js";
import { COLOR_BY_ID, SHAPE_BY_ID } from "../../lib/bot/skins";
import { petRenderer } from "../../lib/pet-personality.js";
import { STATE_BY_ID } from "../../lib/bot/states";
import { BotAnimated } from "./BotAnimated.jsx";
import { ClawdAnimated } from "./ClawdAnimated.jsx";

describe("bot scene mapping", () => {
  it("routes token-burn intensity through distinct engine states", () => {
    expect(botSceneForPetState("working-typing").state).toBe("thinking");
    expect(botSceneForPetState("working-juggling").state).toBe("orbit");
    expect(botSceneForPetState("working-ultrathink").state).toBe("swirl");
    expect(botSceneForPetState("working-overheated").state).toBe("burst");
    expect(botSceneForPetState("sleeping").state).toBe("sleep");
    expect(botSceneForPetState("disconnected").state).toBe("alert");
  });

  it("falls back to idle for states the hosts may push but we do not map", () => {
    expect(botSceneForPetState("not-a-real-state")).toEqual({ state: "idle", expression: "neutre" });
    expect(botSceneForPetState(undefined).state).toBe("idle");
  });

  it("only ever assigns an expression to idle, the one state with a replaceable face", () => {
    for (const petState of botMappedPetStates()) {
      const scene = botSceneForPetState(petState);
      if (!scene.expression) continue;
      expect(STATE_BY_ID.get(scene.state)?.baseFace).toBe(true);
    }
  });

  it("maps only to states the engine actually defines", () => {
    for (const id of botReachableStates()) {
      expect(STATE_BY_ID.get(id), `engine is missing state ${id}`).toBeTruthy();
    }
  });
});

describe("BotAnimated", () => {
  it("punches the eyes out as mask holes rather than laying shapes on top", () => {
    const { container } = render(<BotAnimated state="idle-living" size={64} />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg.getAttribute("viewBox")).toBe("-158 -158 316 316");

    const mask = svg.querySelector("mask");
    expect(mask).toBeTruthy();
    // Body white (opaque), eyes black (the holes).
    expect(mask.querySelector('path[fill="#fff"]')).toBeTruthy();
    expect(mask.querySelectorAll('path[fill="#000"]').length).toBeGreaterThan(0);
    // The body is masked through a filled rect, and backed by an opaque paper
    // path so a ring passing behind the ball cannot show up inside the eyes.
    expect(svg.querySelector(`g[mask="url(#${mask.getAttribute("id")})"] rect`)).toBeTruthy();
  });

  it("renders a body path for every state we map", () => {
    for (const petState of botMappedPetStates()) {
      const { container, unmount } = render(<BotAnimated state={petState} size={48} />);
      const d = container.querySelector("mask path")?.getAttribute("d");
      expect(d, `no body path for ${petState}`).toBeTruthy();
      expect(d.startsWith("M"), `malformed body path for ${petState}: ${d}`).toBe(true);
      unmount();
    }
  });

  it("gives each instance its own mask id so two bots on a page do not collide", () => {
    const { container } = render(
      <>
        <BotAnimated state="idle-living" size={32} />
        <BotAnimated state="working-typing" size={32} />
      </>,
    );
    const ids = [...container.querySelectorAll("mask")].map((m) => m.getAttribute("id"));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("character renderer dispatch", () => {
  it("classifies characters explicitly instead of inferring from a missing atlas", () => {
    expect(petRenderer("clawd")).toBe("clawd");
    expect(petRenderer("bot")).toBe("vector");
    expect(petRenderer("sprout")).toBe("atlas");
    expect(petRenderer("some-community-pet")).toBe("atlas");
  });

  it("sends the bot character to the vector renderer, not the atlas one", async () => {
    const { container } = render(<ClawdAnimated character="bot" state="idle-living" size={64} />);
    // BotAnimated is lazy so the engine stays out of the dashboard entry chunk;
    // the first paint is the Suspense fallback.
    await waitFor(() => expect(container.querySelector("svg mask")).toBeTruthy());
    expect(container.querySelector(".pet-atlas-animated")).toBeNull();
  });
});

describe("bot default look", () => {
  it("rests as an actual circle", () => {
    expect(BOT_DEFAULT_SHAPE).toBe("cercle");
    const radii = SHAPE_BY_ID.get(BOT_DEFAULT_SHAPE).radii;
    expect(radii).toHaveLength(64);
    expect(new Set(radii)).toEqual(new Set([1]));
  });

  it("follows the theme instead of committing to one hue", () => {
    expect(resolveBotColor("auto", false)).toBe("encre");
    expect(resolveBotColor("auto", true)).toBe("creme");
  });

  it("honours a pinned colour, and falls back for a stale one", () => {
    expect(resolveBotColor("bleu", false)).toBe("bleu");
    expect(resolveBotColor("bleu", true)).toBe("bleu");
    expect(resolveBotColor("chartreuse", false)).toBe("encre");
    expect(resolveBotColor(null, true)).toBe("creme");
  });

  it("does not offer ink or cream as pinnable choices — they are what auto resolves to", () => {
    expect(BOT_COLOR_CHOICES).not.toContain("encre");
    expect(BOT_COLOR_CHOICES).not.toContain("creme");
    expect(BOT_COLOR_CHOICES[0]).toBe("auto");
    // A preference stored before they were removed must not stick.
    expect(resolveBotColor("encre", true)).toBe("creme");
  });

  it("only offers palette entries the engine can actually draw", () => {
    for (const id of BOT_COLOR_CHOICES) {
      if (id === "auto") continue;
      expect(COLOR_BY_ID.get(id), `palette is missing ${id}`).toBeTruthy();
    }
  });

  it("paints the body with the resolved colour", () => {
    const { container } = render(<BotAnimated state="idle-living" color="bleu" size={64} />);
    const rect = container.querySelector("g[mask] rect");
    expect(rect.getAttribute("fill")).toBe(COLOR_BY_ID.get("bleu").hex);
  });
});
