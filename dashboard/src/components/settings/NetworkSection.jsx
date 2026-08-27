import React, { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { copy } from "../../lib/copy";
import { Select } from "../../ui/components";
import { SectionCard, SegmentedControl, SettingsRow } from "./Controls.jsx";

const MODE_OPTIONS = () => [
  { value: "system", label: copy("settings.network.mode.system") },
  { value: "manual", label: copy("settings.network.mode.manual") },
  { value: "off", label: copy("settings.network.mode.off") },
];

const PROTOCOL_OPTIONS = () => [
  { value: "http", label: copy("settings.network.protocol.http") },
  { value: "https", label: copy("settings.network.protocol.https") },
  { value: "socks5", label: copy("settings.network.protocol.socks5") },
];

const INPUT_CLASS =
  "w-full rounded-md border border-oai-gray-300 bg-transparent px-2.5 py-1.5 text-sm text-oai-black outline-none focus:border-oai-brand-500 focus:ring-1 focus:ring-inset focus:ring-oai-brand-500 dark:border-oai-gray-700 dark:text-white";

function validateManualDraft(draft) {
  const errors = {};
  const host = String(draft.host || "").trim();
  if (!host || /:\/\//.test(host) || host.includes("/")) {
    errors.host = copy("settings.network.error.host");
  }
  const portRaw = String(draft.port ?? "").trim();
  const port = Number(portRaw);
  if (!portRaw || !/^\d+$/.test(portRaw) || !Number.isInteger(port) || port < 1 || port > 65535) {
    errors.port = copy("settings.network.error.port");
  }
  return errors;
}

export function NetworkSection({ proxySettings }) {
  const { config, save, testConnection } = proxySettings;
  const [draft, setDraft] = useState(() => ({
    mode: config.mode,
    protocol: config.protocol || "http",
    host: config.host || "",
    port: config.port || "",
  }));
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState("");
  const [saveError, setSaveError] = useState(null);
  const [testing, setTesting] = useState(false);
  const [testState, setTestState] = useState(null);

  useEffect(() => {
    setDraft({
      mode: config.mode,
      protocol: config.protocol || "http",
      host: config.host || "",
      port: config.port || "",
    });
  }, [config.mode, config.protocol, config.host, config.port]);

  const effectiveHint = useMemo(() => {
    if (config.effective === "manual") return copy("settings.network.effective.manual");
    if (config.effective === "env") return copy("settings.network.effective.env");
    if (config.effective === "system") return copy("settings.network.effective.system");
    if (config.effective === "blocked") return copy("settings.network.effective.blocked");
    return copy("settings.network.effective.none");
  }, [config.effective]);

  const updateDraft = (patch) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setErrors({});
    setSaveState("");
    setSaveError(null);
    setTestState(null);
  };

  const handleSave = async () => {
    if (draft.mode === "manual") {
      const nextErrors = validateManualDraft(draft);
      if (Object.keys(nextErrors).length) {
        setErrors(nextErrors);
        return;
      }
    }
    setSaving(true);
    setSaveState("");
    setSaveError(null);
    try {
      await save(draft);
      setSaveState("saved");
    } catch (error) {
      setSaveState("error");
      setSaveError(error);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    const nextErrors = validateManualDraft(draft);
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors);
      return;
    }
    setTesting(true);
    setTestState(null);
    try {
      const result = await testConnection(draft);
      setTestState(result);
    } catch (error) {
      setTestState({ ok: false, error: error?.message || String(error) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <SectionCard title={copy("settings.section.network")} subtitle={effectiveHint}>
      {config.applyError ? (
        <p role="alert" className="mb-3 text-xs text-red-600 dark:text-red-400">
          {copy("settings.network.apply_error", { error: config.applyError })}
        </p>
      ) : null}
      <SettingsRow
        label={copy("settings.network.mode.label")}
        hint={copy("settings.network.mode.hint")}
        control={
          <SegmentedControl
            options={MODE_OPTIONS()}
            value={draft.mode}
            onChange={(mode) => updateDraft({ mode })}
          />
        }
      />
      <AnimatePresence initial={false}>
        {draft.mode === "manual" ? (
          <motion.div
            key="manual-proxy-fields"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{
              height: { duration: 0.28, ease: [0.22, 1, 0.36, 1] },
              opacity: { duration: 0.2, ease: [0.22, 1, 0.36, 1] },
            }}
            style={{ overflow: "hidden" }}
            className="divide-y divide-oai-gray-200/60 dark:divide-oai-gray-800/60"
          >
            <SettingsRow
              label={copy("settings.network.protocol.label")}
              control={
                <Select
                  value={draft.protocol}
                  onValueChange={(protocol) => updateDraft({ protocol })}
                  options={PROTOCOL_OPTIONS()}
                  ariaLabel={copy("settings.network.protocol.label")}
                  className="px-2.5 py-1.5 text-xs font-medium"
                />
              }
            />
            <SettingsRow
              label={copy("settings.network.host.label")}
              hint={errors.host}
              control={
                <input
                  type="text"
                  value={draft.host}
                  onChange={(event) => updateDraft({ host: event.target.value })}
                  placeholder={copy("settings.network.host.placeholder")}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={errors.host ? true : undefined}
                  aria-label={copy("settings.network.host.label")}
                  className={INPUT_CLASS}
                />
              }
            />
            <SettingsRow
              label={copy("settings.network.port.label")}
              hint={errors.port}
              control={
                <input
                  type="text"
                  inputMode="numeric"
                  value={draft.port}
                  onChange={(event) => updateDraft({ port: event.target.value })}
                  placeholder={copy("settings.network.port.placeholder")}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={errors.port ? true : undefined}
                  aria-label={copy("settings.network.port.label")}
                  className={INPUT_CLASS}
                />
              }
            />
            <div className="flex flex-wrap items-center justify-end gap-2 py-3">
              <button
                type="button"
                onClick={handleTest}
                disabled={testing || saving}
                className="rounded-md border border-oai-gray-200 px-3 py-1.5 text-xs font-medium text-oai-gray-700 transition-colors hover:bg-oai-gray-100 disabled:opacity-50 dark:border-oai-gray-800 dark:text-oai-gray-300 dark:hover:bg-oai-gray-800"
              >
                {testing ? copy("settings.network.test.testing") : copy("settings.network.test")}
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || testing}
                className="rounded-md bg-oai-brand-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-oai-brand-600 disabled:opacity-50"
              >
                {saving ? copy("settings.network.saving") : copy("settings.network.save")}
              </button>
            </div>
            {testState ? (
              <p className="py-2 text-xs text-oai-gray-500 dark:text-oai-gray-400">
                {testState.ok
                  ? copy("settings.network.test.ok", { status: String(testState.status ?? "") })
                  : copy("settings.network.test.fail", { error: testState.error || "" })}
              </p>
            ) : null}
          </motion.div>
        ) : (
          <div key="non-manual-save" className="flex justify-end py-3">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="rounded-md bg-oai-brand-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-oai-brand-600 disabled:opacity-50"
            >
              {saving ? copy("settings.network.saving") : copy("settings.network.save")}
            </button>
          </div>
        )}
      </AnimatePresence>
      {saveState === "saved" ? (
        <p className="py-2 text-xs text-oai-gray-500 dark:text-oai-gray-400">
          {copy("settings.network.saved")}
        </p>
      ) : null}
      {saveState === "error" ? (
        <p role="alert" className="py-2 text-xs text-red-600 dark:text-red-400">
          {saveError?.unprotected
            ? copy("settings.network.save_error_unprotected", {
                error: saveError?.message || String(saveError || ""),
              })
            : copy("settings.network.save_error", {
                error: saveError?.message || String(saveError || ""),
              })}
        </p>
      ) : null}
    </SectionCard>
  );
}
