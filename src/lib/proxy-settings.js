"use strict";

const net = require("node:net");

const PROXY_MODES = new Set(["system", "manual", "off"]);
const PROXY_PROTOCOLS = new Set(["http", "https", "socks5"]);

function defaultProxyConfig() {
  return {
    mode: "system",
    protocol: "http",
    host: "",
    port: 0,
  };
}

function normalizeMode(value) {
  if (typeof value !== "string") return null;
  const mode = value.trim().toLowerCase();
  return PROXY_MODES.has(mode) ? mode : null;
}

function normalizeProtocol(value) {
  if (typeof value !== "string") return null;
  const protocol = value.trim().toLowerCase();
  if (protocol === "socks") return "socks5";
  return PROXY_PROTOCOLS.has(protocol) ? protocol : null;
}

function normalizeHost(value) {
  if (typeof value !== "string") return null;
  const host = value.trim();
  if (!host) return null;
  if (/:\/\//.test(host) || host.includes("/")) return null;
  // Reject credentials, query/hash fragments, Windows-style paths, and
  // internal whitespace so a host cannot reshape the assembled proxy URL.
  if (/[@?#\\]/.test(host) || /\s/.test(host)) return null;
  return host;
}

function normalizePort(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || !/^\d+$/.test(trimmed)) return null;
    value = Number(trimmed);
  }
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 1 || value > 65535) return null;
  return value;
}

function fallbackSystem(reason) {
  return { ...defaultProxyConfig(), reason };
}

/**
 * Normalize a persisted or inbound proxy object.
 * Invalid values fall back to mode=system and never throw.
 */
function normalizeProxyConfig(raw) {
  if (raw == null) return defaultProxyConfig();
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return fallbackSystem("proxy config must be an object");
  }

  const mode = raw.mode == null || raw.mode === ""
    ? "system"
    : normalizeMode(raw.mode);
  if (!mode) return fallbackSystem("invalid mode");

  const protocol = normalizeProtocol(raw.protocol) || "http";
  const host = typeof raw.host === "string" ? raw.host.trim() : "";
  const port = normalizePort(raw.port) ?? 0;

  if (mode !== "manual") {
    return { mode, protocol, host, port };
  }

  const manualProtocol = normalizeProtocol(raw.protocol);
  if (!manualProtocol) return fallbackSystem("invalid protocol");
  const manualHost = normalizeHost(raw.host);
  if (!manualHost) return fallbackSystem("invalid host");
  const manualPort = normalizePort(raw.port);
  if (manualPort == null) return fallbackSystem("invalid port");
  return {
    mode: "manual",
    protocol: manualProtocol,
    host: manualHost,
    port: manualPort,
  };
}

/**
 * Strict payload check for POST /proxy-config.
 * Rejects illegal values instead of coercing them.
 */
function parseProxyPayload(raw) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "proxy payload must be an object" };
  }
  const mode = normalizeMode(raw.mode);
  if (!mode) {
    return { ok: false, error: "mode must be system, manual, or off" };
  }
  if (mode !== "manual") {
    return {
      ok: true,
      value: {
        mode,
        protocol: normalizeProtocol(raw.protocol) || "http",
        host: typeof raw.host === "string" ? raw.host.trim() : "",
        port: normalizePort(raw.port) ?? 0,
      },
    };
  }
  const protocol = normalizeProtocol(raw.protocol);
  if (!protocol) {
    return { ok: false, error: "protocol must be http, https, or socks5" };
  }
  const host = normalizeHost(raw.host);
  if (!host) {
    return { ok: false, error: "host must be a hostname or IP without a protocol prefix" };
  }
  const port = normalizePort(raw.port);
  if (port == null) {
    return { ok: false, error: "port must be an integer from 1 to 65535" };
  }
  return { ok: true, value: { mode, protocol, host, port } };
}

function bracketProxyHost(host) {
  if (net.isIPv6(host)) return `[${host}]`;
  if (host.startsWith("[") && host.endsWith("]")) {
    const inner = host.slice(1, -1);
    if (net.isIPv6(inner)) return `[${inner}]`;
  }
  // Bare or malformed hosts that merely contain a colon are not IPv6.
  if (host.includes(":")) return null;
  return host;
}

function buildProxyUrl(normalized) {
  if (!normalized || normalized.mode !== "manual") return null;
  const protocol = normalizeProtocol(normalized.protocol);
  const host = normalizeHost(normalized.host);
  const port = normalizePort(normalized.port);
  if (!protocol || !host || port == null) return null;
  const hostPart = bracketProxyHost(host);
  if (!hostPart) return null;
  return `${protocol}://${hostPart}:${port}`;
}

module.exports = {
  PROXY_MODES,
  PROXY_PROTOCOLS,
  defaultProxyConfig,
  normalizeProxyConfig,
  parseProxyPayload,
  buildProxyUrl,
  normalizeProtocol,
  normalizeHost,
  normalizePort,
};
