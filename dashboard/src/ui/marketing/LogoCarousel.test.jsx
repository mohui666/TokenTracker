import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLocale } from "../../hooks/useLocale.js";
import { EN_LOCALE, LOCALE_STORAGE_KEY, ZH_CN_LOCALE } from "../../lib/locale";
import { LocaleProvider } from "../foundation/LocaleProvider.jsx";
import { LogoCarousel } from "./LogoCarousel.jsx";

const TRAE_LOGO = {
  id: 32,
  name: "TRAE Work CN",
  nameKey: "provider.display.trae_work_cn",
  provider: "trae-cn",
};

function LocaleProbe() {
  const { setLocale } = useLocale();

  return (
    <button type="button" onClick={() => setLocale(ZH_CN_LOCALE)}>
      {"switch-to-zh"}
    </button>
  );
}

beforeEach(() => {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, EN_LOCALE);
  vi.spyOn(globalThis, "setInterval").mockImplementation(() => 0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LogoCarousel localization", () => {
  it("resolves keyed logo names using the current locale at render time", async () => {
    const { container } = render(
      <LocaleProvider>
        <LocaleProbe />
        <LogoCarousel logos={[TRAE_LOGO]} columnCount={1} />
      </LocaleProvider>,
    );

    let icon;
    await waitFor(() => {
      icon = container.querySelector('svg[data-brand="trae-cn"]');
      expect(icon).not.toBeNull();
    });
    fireEvent.mouseEnter(icon);
    expect(await screen.findByText("TRAE Work CN")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "switch-to-zh" }));
    expect(await screen.findByText("TRAE Work 中国版")).toBeInTheDocument();
  });
});
