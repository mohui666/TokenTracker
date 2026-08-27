import React from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage.jsx";

const nativeSettingsMock = vi.hoisted(() => ({
  available: true,
  settings: {
    toastOnReset: true,
    confettiOnReset: true,
  },
  setSetting: vi.fn(),
}));

const proxySettingsMock = vi.hoisted(() => ({
  available: false,
}));

const LABELS = {
  "settings.page.title": "Settings",
  "settings.page.subtitle": "Manage your preferences",
  "settings.section.appearance": "Appearance",
  "settings.section.menubar": "Menu Bar App",
  "settings.section.limits": "Limits Display",
  "settings.section.labs": "Labs",
  "settings.section.network": "Network",
  "settings.limits.providers": "Providers",
  "limits.settings.display_mode_label": "Usage Display",
  "settings.menubar.toastOnReset": "Toast on limits reset",
  "settings.menubar.toastOnResetHint": "Show a useful reset message",
  "settings.menubar.confettiOnReset": "Confetti on limits reset",
  "settings.menubar.confettiOnResetHint": "Play the reset celebration effect",
};

vi.mock("../lib/copy", () => ({
  copy: (key) => LABELS[key] || key,
}));

vi.mock("../lib/native-bridge", () => ({
  isNativeApp: () => true,
  isBridgeAvailable: () => nativeSettingsMock.available,
}));

vi.mock("../hooks/use-limits-display-prefs.js", () => ({
  LIMIT_DISPLAY_MODES: { USED: "used", REMAINING: "remaining" },
  useLimitsDisplayPrefs: () => ({
    displayMode: "used",
    setDisplayMode: vi.fn(),
  }),
}));

vi.mock("../hooks/use-native-settings.js", () => ({
  useNativeSettings: () => ({
    available: nativeSettingsMock.available,
    settings: nativeSettingsMock.settings,
    setSetting: nativeSettingsMock.setSetting,
  }),
}));

vi.mock("../hooks/use-proxy-settings.js", () => ({
  useProxySettings: () => ({
    available: proxySettingsMock.available,
    loading: false,
    config: { mode: "system", protocol: "http", host: "", port: "", effective: "none" },
    save: vi.fn(),
    testConnection: vi.fn(),
  }),
}));

vi.mock("../components/settings/AppearanceSection.jsx", () => ({
  AppearanceSection: () => <div data-testid="appearance-content" />,
}));

vi.mock("../components/settings/MenuBarSection.jsx", () => ({
  MenuBarSection: () => <div data-testid="native-content" />,
  NativeAppFooter: () => <footer data-testid="settings-footer" />,
}));

vi.mock("../components/settings/LabsSection.jsx", () => ({
  LabsSection: () => <div data-testid="labs-content" />,
}));

vi.mock("../components/settings/NetworkSection.jsx", () => ({
  NetworkSection: () => <div data-testid="network-content" />,
}));

vi.mock("../components/LimitsSettingsPanel.jsx", () => ({
  LimitsSettingsPanel: () => <div data-testid="limits-content" />,
}));

vi.mock("../components/settings/Controls.jsx", () => ({
  SectionCard: ({ title, children }) => (
    <div data-testid="section-card" data-section-card-title={title}>
      {children}
    </div>
  ),
  SettingsRow: ({ label, control }) => (
    <div>
      <span>{label}</span>
      {control}
    </div>
  ),
  SegmentedControl: () => <div data-testid="limits-mode" />,
  ToggleSwitch: ({ checked, onChange, disabled, ariaLabel }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={onChange}
      disabled={disabled}
    />
  ),
}));

function renderSettings(initialPath = "/settings") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <SettingsPage />
    </MemoryRouter>,
  );
}

describe("SettingsPage category navigation", () => {
  beforeEach(() => {
    nativeSettingsMock.available = true;
    nativeSettingsMock.settings = {
      toastOnReset: true,
      confettiOnReset: true,
    };
    nativeSettingsMock.setSetting.mockReset();
    proxySettingsMock.available = false;
  });

  it("switches the visible category while keeping every section mounted", async () => {
    const user = userEvent.setup();
    const { container } = renderSettings();

    const appearanceButton = screen.getByRole("button", { name: "Appearance" });
    const labsButton = screen.getByRole("button", { name: "Labs" });
    const appearancePanel = container.querySelector('[data-settings-panel="appearance"]');
    const labsPanel = container.querySelector('[data-settings-panel="labs"]');

    expect(appearanceButton).toHaveAttribute("aria-current", "page");
    expect(appearancePanel).not.toHaveAttribute("hidden");
    expect(labsPanel).toHaveAttribute("hidden");
    expect(screen.getByTestId("appearance-content")).toBeInTheDocument();
    expect(screen.getByTestId("labs-content")).toBeInTheDocument();

    await act(async () => {
      await user.click(labsButton);
    });

    expect(labsButton).toHaveAttribute("aria-current", "page");
    expect(appearanceButton).not.toHaveAttribute("aria-current");
    expect(appearancePanel).toHaveAttribute("hidden");
    expect(labsPanel).not.toHaveAttribute("hidden");
  });

  it("omits the network category when the local proxy API is unavailable", () => {
    proxySettingsMock.available = false;
    const { container } = renderSettings();

    expect(screen.queryByRole("button", { name: "Network" })).not.toBeInTheDocument();
    expect(container.querySelector('[data-settings-panel="network"]')).toBeNull();
  });

  it("shows the network category when the local proxy API is available", () => {
    proxySettingsMock.available = true;
    const { container } = renderSettings();

    expect(screen.getByRole("button", { name: "Network" })).toBeInTheDocument();
    expect(container.querySelector('[data-settings-panel="network"]')).not.toBeNull();
    expect(screen.getByTestId("network-content")).toBeInTheDocument();
  });

  it("omits the native-app category when the native bridge is unavailable", () => {
    nativeSettingsMock.available = false;
    const { container } = renderSettings();

    expect(screen.queryByRole("button", { name: "Menu Bar App" })).not.toBeInTheDocument();
    expect(container.querySelector('[data-settings-panel="native-app"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Appearance" })).toHaveAttribute("aria-current", "page");
  });

  it("keeps reset feedback settings visible but disabled without the native bridge", () => {
    nativeSettingsMock.available = false;
    renderSettings("/settings?section=limits");

    expect(screen.getByRole("switch", { name: "Toast on limits reset" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Confetti on limits reset" })).toBeDisabled();
  });

  it("selects Limits Display from a settings deep link", () => {
    const { container } = renderSettings("/settings?section=limits");

    expect(screen.getByRole("button", { name: "Limits Display" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(container.querySelector('[data-settings-panel="limits"]')).not.toHaveAttribute("hidden");
    expect(container.querySelector('[data-settings-panel="appearance"]')).toHaveAttribute("hidden");
  });

  it("offers independent reset toast and confetti settings in Limits Display", async () => {
    const user = userEvent.setup();
    renderSettings("/settings?section=limits");

    const toastSwitch = screen.getByRole("switch", { name: "Toast on limits reset" });
    const confettiSwitch = screen.getByRole("switch", { name: "Confetti on limits reset" });

    expect(toastSwitch).toHaveAttribute("aria-checked", "true");
    expect(confettiSwitch).toHaveAttribute("aria-checked", "true");

    await act(async () => {
      await user.click(toastSwitch);
      await user.click(confettiSwitch);
    });

    expect(nativeSettingsMock.setSetting).toHaveBeenCalledWith("toastOnReset", false);
    expect(nativeSettingsMock.setSetting).toHaveBeenCalledWith("confettiOnReset", false);
  });

  it("groups display mode and reset feedback above the provider list", () => {
    renderSettings("/settings?section=limits");

    const [settingsCard, providersCard] = screen.getAllByTestId("section-card");
    expect(settingsCard.dataset.sectionCardTitle).toBe("Limits Display");
    expect(within(settingsCard).getByTestId("limits-mode")).toBeInTheDocument();
    expect(within(settingsCard).getByRole("switch", { name: "Toast on limits reset" })).toBeInTheDocument();
    expect(within(settingsCard).getByRole("switch", { name: "Confetti on limits reset" })).toBeInTheDocument();

    expect(providersCard.dataset.sectionCardTitle).toBe("Providers");
    expect(within(providersCard).getByTestId("limits-content")).toBeInTheDocument();
  });
});
