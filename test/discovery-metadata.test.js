"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

const README_EXPECTATIONS = [
  ["README.md", /34 AI coding tools/, /\|\s+\*\*AI tools supported\*\*\s+\|\s+\*\*34\*\*/, /Rate-limit tracking.*✅ 13 providers/],
  ["README.zh-CN.md", /34 款 AI 编码工具/, /\|\s+\*\*支持的 AI 工具数\*\*\s+\|\s+\*\*34\*\*/, /限额追踪.*✅ 13 家 provider/],
  ["README.ja.md", /34 種類の AI コーディングツール/, /\|\s+\*\*対応 AI ツール数\*\*\s+\|\s+\*\*34\*\*/, /レート制限トラッキング.*✅ 13 プロバイダー/],
  ["README.ko.md", /34개의 AI 코딩 도구/, /\|\s+\*\*지원하는 AI 도구 수\*\*\s+\|\s+\*\*34\*\*/, /레이트 제한 추적.*✅ 13개 프로바이더/],
  ["README.de.md", /34 KI-Coding-Tools/, /\|\s+\*\*Unterstützte KI-Tools\*\*\s+\|\s+\*\*34\*\*/, /Rate-Limit-Tracking.*✅ 13 Provider/],
];

test("public discovery surfaces describe all 34 supported tools", () => {
  for (const [file, countPattern, comparisonPattern, limitCountPattern] of README_EXPECTATIONS) {
    const source = read(file);
    assert.match(source, countPattern, `${file} has the current provider count`);
    assert.match(source, comparisonPattern, `${file} comparison table has the current provider count`);
    assert.match(source, /Droid/, `${file} lists Droid`);
    assert.match(source, /AnythingLLM Desktop/, `${file} lists AnythingLLM Desktop`);
    assert.match(source, /Qoder/, `${file} lists Qoder`);
    assert.match(source, /DeepSeek Harness/, `${file} lists DeepSeek Harness`);
    assert.match(source, /Prime Agent/, `${file} lists Prime Agent`);
    assert.match(source, /TRAE Work CN/, `${file} lists TRAE Work CN`);
    assert.match(source, limitCountPattern, `${file} rate-limit row carries the current usage-limits provider count`);
  }

  const index = read("dashboard/index.html");
  assert.doesNotMatch(index, /13 AI coding/);
  assert.match(index, /Supported AI coding tools \(34\)/);
  assert.match(index, /TRAE Work CN/);
  assert.match(index, /Desktop pet/);
  assert.match(index, /Four desktop widgets/);
  assert.match(index, /Achievements/);
  assert.match(index, /Service Status page/);
  assert.match(index, /usage limits for 13 providers/i);

  const llms = read("dashboard/public/llms.txt");
  assert.match(llms, /Supported AI coding tools \(34\)/);
  assert.match(llms, /TRAE Work CN/);
  assert.match(llms, /desktop pet/i);
  assert.match(llms, /four desktop widgets/i);
  assert.match(llms, /achievements/i);
});

test("marketing logo wall includes the same 34 product integrations", () => {
  const source = read("dashboard/src/ui/marketing/agent-logos.js");
  const providers = [...source.matchAll(/provider:\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.equal(providers.length, 34);
  assert.equal(new Set(providers).size, 34);

  for (const provider of ["every-code", "reasonix", "kilocode", "roocode", "zed", "goose", "droid", "qoder", "anythingllm", "dsh", "prime-agent", "trae-cn", "dots"]) {
    assert.ok(providers.includes(provider), `logo wall includes ${provider}`);
  }
});

test("CLI onboarding advertises the same 34 supported integrations", () => {
  const source = read("src/commands/init.js");
  const block = source.match(/const SUPPORTED_PROVIDERS = \[([\s\S]*?)\];/);
  assert.ok(block, "init defines SUPPORTED_PROVIDERS");

  const providers = [...block[1].matchAll(/^\s*"([^"]+)",?$/gm)].map((match) => match[1]);
  assert.equal(providers.length, 34);
  assert.equal(new Set(providers).size, 34);
  assert.ok(providers.includes("Droid"));
  assert.ok(providers.includes("AnythingLLM Desktop"));
  assert.ok(providers.includes("Qoder"));
  assert.ok(providers.includes("Reasonix"));
  assert.ok(providers.includes("DeepSeek Harness"));
  assert.ok(providers.includes("Prime Agent"));
  assert.ok(providers.includes("TRAE Work CN"));
  assert.ok(providers.includes("Dots"));
});

test("npm metadata carries the current product hook", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.match(pkg.description, /34 tools/);
  assert.match(pkg.description, /desktop pet/);
  assert.ok(pkg.keywords.includes("desktop-widget"));
  assert.ok(pkg.keywords.includes("ai-coding-tools"));
});

test("dashboard JSON-LD scripts parse as valid JSON", () => {
  const index = read("dashboard/index.html");
  const blocks = [...index.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((match) => match[1]);
  assert.ok(blocks.length > 0, "dashboard/index.html includes JSON-LD");

  const parsed = blocks.map((block, i) => {
    try {
      return JSON.parse(block);
    } catch (err) {
      assert.fail(`JSON-LD block ${i} failed to parse: ${err.message}`);
    }
  });

  const graph = parsed.flatMap((doc) => (Array.isArray(doc["@graph"]) ? doc["@graph"] : [doc]));

  const faq = graph.find((node) => node["@type"] === "FAQPage");
  assert.ok(faq, "JSON-LD includes an FAQPage");
  const supportedClis = (faq.mainEntity || []).find((entity) =>
    entity.name === "Which AI coding CLIs does Token Tracker support?",
  );
  assert.ok(supportedClis, "FAQ includes the supported-CLIs question");
  assert.equal(supportedClis["@type"], "Question");

  const tools = graph.find((node) => node["@type"] === "ItemList" && node.name === "Supported AI coding agent CLIs");
  assert.ok(tools, "JSON-LD includes the coding-tools ItemList");
  assert.ok(Array.isArray(tools.itemListElement), "coding-tools ItemList is an array");
});
