import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProviderIcon } from "./ProviderIcon.jsx";

describe("ProviderIcon", () => {
  it("renders the official AnythingLLM mark with explicit light and dark treatment", () => {
    const { container } = render(
      <ProviderIcon provider="anythingllm" size={20} className="shrink-0" />,
    );

    const icon = container.querySelector('img[src="/brand-logos/anythingllm.svg"]');
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute("width", "20");
    expect(icon).toHaveAttribute("height", "20");
    expect(icon).toHaveClass("brightness-0", "dark:brightness-100", "shrink-0");
  });

  it("renders Qoder from the Lobe Icons brand asset", () => {
    const { container } = render(<ProviderIcon provider="qoder" size={20} />);
    const icon = container.querySelector('img[src="/brand-logos/qoder.svg"]');

    expect(icon).not.toBeNull();
    expect(icon).toHaveClass("dark:invert");
  });

  it("keeps the theme-aware placeholder for unknown providers", () => {
    const { container } = render(<ProviderIcon provider="unknown-provider" />);
    const placeholder = container.querySelector("svg");

    expect(placeholder).toHaveClass("text-oai-gray-400", "dark:text-oai-gray-500");
    expect(placeholder?.querySelector("circle")).not.toBeNull();
  });

  it("renders the MiniMax brand mark instead of the unknown-provider placeholder", () => {
    const { container } = render(<ProviderIcon provider="MINIMAX" size={18} />);
    const icon = container.querySelector("svg");

    expect(icon).toHaveAttribute("width", "18");
    expect(icon).toHaveAttribute("height", "18");
    expect(icon?.querySelector("path")).not.toBeNull();
    expect(icon?.querySelector("circle")).toBeNull();
  });

  it("renders the multi-color oh-my-pi brand logo", () => {
    const { container } = render(<ProviderIcon provider="omp" size={20} />);
    const icon = container.querySelector('img[src="/brand-logos/omp.svg"]');
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute("width", "20");
    expect(icon).toHaveAttribute("height", "20");
  });

  it("renders the multi-color Pi brand logo", () => {
    const { container } = render(<ProviderIcon provider="pi" size={18} />);
    const icon = container.querySelector('img[src="/brand-logos/pi.svg"]');
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute("width", "18");
  });

  it("renders the Reasonix brand icon", () => {
    const { container } = render(<ProviderIcon provider="reasonix" size={20} />);
    const icon = container.querySelector('img[src="/brand-logos/reasonix.png"]');

    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute("width", "20");
    expect(icon).toHaveAttribute("height", "20");
  });

  it("renders the official theme-aware DeepSeek Harness fish instead of the legacy blue asset", () => {
    for (const provider of ["dsh", "deepseek"]) {
      const { container } = render(<ProviderIcon provider={provider} size={20} />);
      const icon = container.querySelector('svg[data-brand="deepseek-harness"]');

      expect(icon).not.toBeNull();
      expect(icon).toHaveAttribute("width", "20");
      expect(icon).toHaveAttribute("viewBox", "0 0 23.16 17.04");
      expect(container.querySelector('img[src="/brand-logos/deepseek.svg"]')).toBeNull();
      expect(icon?.querySelector('path[fill="currentColor"]')).not.toBeNull();
    }
  });
});

  it("renders the Qoder CN green-crescent mark from its own asset", () => {
    const { container } = render(<ProviderIcon provider="qoder-cn" size={16} />);
    const icon = container.querySelector('img[src="/brand-logos/qoder-cn.svg"]');

    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute("width", "16");
    expect(icon).not.toHaveClass("dark:invert");
  });

  it("renders the multi-color Pi mark for the DeepSeek and OpenAI-Codex variants", () => {
    for (const provider of ["pi-deepseek", "pi-openai-codex"]) {
      const { container } = render(<ProviderIcon provider={provider} size={16} />);
      const icon = container.querySelector('img[src="/brand-logos/pi.svg"]');
      expect(icon, `${provider} maps to pi.svg`).not.toBeNull();
    }
  });
