import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const COPY_PATH = path.resolve(PLUGIN_DIR, "..", "src", "content", "copy.csv");
const PUBLIC_ID = "virtual:tokentracker-copy-registry";
const RESOLVED_ID = `\0${PUBLIC_ID}`;
const REQUIRED_COLUMNS = ["key", "module", "page", "component", "slot", "text"];

function parseCsv(raw) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];

    if (inQuotes) {
      if (character === '"') {
        if (raw[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      inQuotes = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      field = "";
      if (!row.every((cell) => cell.trim() === "")) rows.push(row);
      row = [];
    } else if (character !== "\r") {
      field += character;
    }
  }

  row.push(field);
  if (!row.every((cell) => cell.trim() === "")) rows.push(row);
  return rows;
}

export function readCopyRegistry(copyPath = COPY_PATH) {
  const rows = parseCsv(fs.readFileSync(copyPath, "utf8"));
  if (!rows.length) throw new Error(`Copy registry is empty: ${copyPath}`);

  const header = rows[0].map((cell) => cell.trim());
  const missingColumns = REQUIRED_COLUMNS.filter((column) => !header.includes(column));
  if (missingColumns.length) {
    throw new Error(`Copy registry missing columns: ${missingColumns.join(", ")}`);
  }

  const columnIndexes = Object.fromEntries(header.map((column, index) => [column, index]));
  const registry = Object.create(null);

  rows.slice(1).forEach((cells, rowIndex) => {
    const key = String(cells[columnIndexes.key] || "").trim();
    const text = String(cells[columnIndexes.text] ?? "").trim();
    if (!key) return;
    if (Object.hasOwn(registry, key)) {
      throw new Error(`Duplicate copy key '${key}' on row ${rowIndex + 2}`);
    }
    registry[key] = text;
  });

  return registry;
}

export function copyRegistryPlugin() {
  return {
    name: "tokentracker-copy-registry",
    resolveId(id) {
      return id === PUBLIC_ID ? RESOLVED_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_ID) return null;
      this.addWatchFile(COPY_PATH);
      return `export default ${JSON.stringify(readCopyRegistry())};`;
    },
  };
}
