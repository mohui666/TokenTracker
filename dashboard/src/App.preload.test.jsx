import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.jsx";
import {
  markDashboardMainContentVisible,
  preloadDashboardPageResources,
} from "./lib/dashboard-preload.js";

const TEXT = {
  achievements: "Achievements page",
  dashboard: "Dashboard page",
  landing: "Landing page",
  limits: "Limits page",
  limitsNav: "Limits nav",
  pet: "Pet page",
  reveal: "reveal main content",
  serviceStatus: "Service status page",
  sessions: "Sessions page",
  settings: "Settings page",
  skills: "Skills page",
  widgets: "Widgets page",
  wrapped: "Wrapped page",
};

vi.mock("./lib/dashboard-preload.js", () => ({
  markDashboardMainContentVisible: vi.fn(),
  preloadDashboardPageResources: vi.fn(() => Promise.resolve([])),
}));

vi.mock("./hooks/useLocale.js", () => ({
  useLocale: () => ({ resolvedLocale: "en" }),
}));

vi.mock("./lib/mock-mode", () => ({
  isMockEnabled: () => false,
}));

vi.mock("./lib/config", () => ({
  getBackendBaseUrl: () => "",
}));

vi.mock("./lib/screenshot-mode", () => ({
  isScreenshotModeEnabled: () => false,
}));

vi.mock("./components/ErrorBoundary.jsx", () => ({
  ErrorBoundary: ({ children }) => <>{children}</>,
}));

vi.mock("./ui/foundation/ThemeProvider.jsx", () => ({
  ThemeProvider: ({ children }) => <>{children}</>,
}));

vi.mock("./ui/components/Sidebar.jsx", () => ({
  AppLayout: ({ children }) => (
    <div>
      <a href="/limits" onClick={(event) => event.preventDefault()}>
        {TEXT.limitsNav}
      </a>
      {children}
    </div>
  ),
}));

vi.mock("./ui/dashboard/components/CommandPalette.jsx", () => ({
  CommandPalette: () => null,
}));

vi.mock("./pages/DashboardPage.jsx", () => ({
  DashboardPage: ({ onMainContentVisible }) => (
    <main>
      <h1>{TEXT.dashboard}</h1>
      <button type="button" onClick={onMainContentVisible}>
        {TEXT.reveal}
      </button>
    </main>
  ),
}));

vi.mock("./pages/LimitsPage.jsx", () => ({
  LimitsPage: ({ onMainContentVisible }) => {
    React.useEffect(() => {
      onMainContentVisible?.();
    }, [onMainContentVisible]);
    return <main>{TEXT.limits}</main>;
  },
}));

vi.mock("./pages/ServiceStatusPage.jsx", () => ({ default: () => <main>{TEXT.serviceStatus}</main> }));
vi.mock("./pages/AchievementsPage.jsx", () => ({ default: () => <main>{TEXT.achievements}</main> }));
vi.mock("./pages/LandingPage.jsx", () => ({ LandingPage: () => <main>{TEXT.landing}</main> }));
vi.mock("./pages/WrappedPage.jsx", () => ({ default: () => <main>{TEXT.wrapped}</main> }));
vi.mock("./pages/SettingsPage.jsx", () => ({ SettingsPage: () => <main>{TEXT.settings}</main> }));
vi.mock("./pages/SkillsPage.jsx", () => ({ SkillsPage: () => <main>{TEXT.skills}</main> }));
vi.mock("./pages/SessionsPage.jsx", () => ({ SessionsPage: () => <main>{TEXT.sessions}</main> }));
vi.mock("./pages/WidgetsPage.jsx", () => ({ WidgetsPage: () => <main>{TEXT.widgets}</main> }));
vi.mock("./pages/PetPage.jsx", () => ({ PetPage: () => <main>{TEXT.pet}</main> }));

function renderApp(initialPath = "/dashboard") {
  window.history.pushState({}, "", initialPath);
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <App />
    </MemoryRouter>,
  );
}

describe("App deferred dashboard preload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.pushState({}, "", "/");
  });

  it("does not start target preload before the dashboard main content is visible", async () => {
    const user = userEvent.setup();
    renderApp("/dashboard");

    expect(await screen.findByText(TEXT.dashboard)).toBeInTheDocument();
    expect(preloadDashboardPageResources).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: TEXT.reveal }));

    await waitFor(() => {
      expect(markDashboardMainContentVisible).toHaveBeenCalledTimes(1);
      expect(preloadDashboardPageResources).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    ["/limits", TEXT.limits],
    ["/settings", TEXT.settings],
    ["/achievements", TEXT.achievements],
  ])("does not start dashboard preload for deep-linked %s", async (path, pageText) => {
    renderApp(path);

    expect(await screen.findByText(pageText)).toBeInTheDocument();

    await waitFor(() => {
      expect(markDashboardMainContentVisible).not.toHaveBeenCalled();
      expect(preloadDashboardPageResources).not.toHaveBeenCalled();
    });
  });

  it.each([
    "/leaderboard",
    "/login",
    "/reset-password",
    "/auth/callback",
    "/auth/native-callback",
    "/device",
    "/ip-check",
    "/share/some-token",
    "/u/some-user",
  ])("treats removed route %s as the local dashboard", async (path) => {
    renderApp(path);

    // Removed cloud/hosted routes fall through to the dashboard page; the
    // deep-link guard means this fall-through must NOT kick off a preload.
    expect(await screen.findByText(TEXT.dashboard)).toBeInTheDocument();
    expect(markDashboardMainContentVisible).not.toHaveBeenCalled();
    expect(preloadDashboardPageResources).not.toHaveBeenCalled();
  });

  it("serves the landing page on /landing", async () => {
    renderApp("/landing");

    expect(await screen.findByText(TEXT.landing)).toBeInTheDocument();
    expect(preloadDashboardPageResources).not.toHaveBeenCalled();
  });
});
