import React from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkSection } from "./NetworkSection.jsx";

const hookMock = vi.hoisted(() => ({
  available: true,
  loading: false,
  config: {
    mode: "manual",
    protocol: "http",
    host: "",
    port: "",
    effective: "none",
  },
  save: vi.fn(),
  testConnection: vi.fn(),
}));

vi.mock("../../lib/copy", () => ({
  copy: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
}));

describe("NetworkSection", () => {
  beforeEach(() => {
    hookMock.available = true;
    hookMock.config = {
      mode: "manual",
      protocol: "http",
      host: "",
      port: "",
      effective: "none",
      applyError: null,
    };
    hookMock.save.mockReset();
    hookMock.testConnection.mockReset();
  });

  it("labels the fail-closed state as blocked, not as a direct connection", () => {
    hookMock.config = {
      ...hookMock.config,
      effective: "blocked",
      applyError: "invalid port",
    };
    render(<NetworkSection proxySettings={hookMock} />);

    expect(screen.getByText("settings.network.effective.blocked")).toBeTruthy();
    expect(screen.queryByText("settings.network.effective.none")).toBeNull();
  });

  it("does not save in manual mode when host and port fail validation", async () => {
    const user = userEvent.setup();
    render(<NetworkSection proxySettings={hookMock} />);

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.network.save" }));
    });

    expect(hookMock.save).not.toHaveBeenCalled();
    expect(screen.getByText("settings.network.error.host")).toBeInTheDocument();
    expect(screen.getByText("settings.network.error.port")).toBeInTheDocument();
  });

  it("does not save when the host includes a protocol prefix", async () => {
    const user = userEvent.setup();
    hookMock.config = {
      mode: "manual",
      protocol: "http",
      host: "http://127.0.0.1",
      port: "7890",
      effective: "none",
    };
    render(<NetworkSection proxySettings={hookMock} />);

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.network.save" }));
    });

    expect(hookMock.save).not.toHaveBeenCalled();
    expect(screen.getByText("settings.network.error.host")).toBeInTheDocument();
  });

  it("surfaces a last-apply failure from the local API", () => {
    hookMock.config = {
      mode: "manual",
      protocol: "socks5",
      host: "127.0.0.1",
      port: "7890",
      effective: "manual",
      applyError: "bad url",
    };
    render(<NetworkSection proxySettings={hookMock} />);
    expect(screen.getByRole("alert")).toHaveTextContent("settings.network.apply_error");
  });

  it("shows saved feedback for system mode (outside the manual-only branch)", async () => {
    const user = userEvent.setup();
    hookMock.config = {
      mode: "system",
      protocol: "http",
      host: "",
      port: "",
      effective: "system",
      applyError: null,
    };
    hookMock.save.mockResolvedValue({});
    render(<NetworkSection proxySettings={hookMock} />);

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.network.save" }));
    });

    expect(hookMock.save).toHaveBeenCalled();
    expect(screen.getByText("settings.network.saved")).toBeInTheDocument();
  });

  it("shows saved feedback for off mode", async () => {
    const user = userEvent.setup();
    hookMock.config = {
      mode: "off",
      protocol: "http",
      host: "",
      port: "",
      effective: "none",
      applyError: null,
    };
    hookMock.save.mockResolvedValue({});
    render(<NetworkSection proxySettings={hookMock} />);

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.network.save" }));
    });

    expect(screen.getByText("settings.network.saved")).toBeInTheDocument();
  });

  it("shows an error alert with the backend reason when save() throws", async () => {
    const user = userEvent.setup();
    hookMock.config = {
      mode: "manual",
      protocol: "http",
      host: "127.0.0.1",
      port: "7890",
      effective: "none",
      applyError: null,
    };
    hookMock.save.mockRejectedValue(new Error("bind failed"));
    render(<NetworkSection proxySettings={hookMock} />);

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.network.save" }));
    });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("settings.network.save_error");
    expect(alert).toHaveTextContent("bind failed");
  });

  it("uses the unprotected copy key when the thrown error is flagged unprotected", async () => {
    const user = userEvent.setup();
    hookMock.config = {
      mode: "manual",
      protocol: "http",
      host: "127.0.0.1",
      port: "7890",
      effective: "none",
      applyError: null,
    };
    const err = new Error("blocking failed too");
    err.unprotected = true;
    hookMock.save.mockRejectedValue(err);
    render(<NetworkSection proxySettings={hookMock} />);

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.network.save" }));
    });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("settings.network.save_error_unprotected");
    expect(alert).toHaveTextContent("blocking failed too");
  });
});
