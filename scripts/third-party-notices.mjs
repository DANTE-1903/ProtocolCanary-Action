import { build } from "esbuild";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { BUILD_OPTIONS } from "./build-options.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..");
const OUTPUT_FILE = "THIRD_PARTY_NOTICES.txt";
const REVIEWED_LICENSES = new Set([
  "MIT",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "0BSD",
]);
const LICENSE_FILE_PATTERN = /^(LICENSE|LICENCE|COPYING)/i;
const NOTICE_FILE_PATTERN = /^NOTICE/i;
const INVENTORY_LINE = /^NOTICES-PACKAGE: (.+)$/;

function normalizeNewlines(text) {
  return text.replace(/\r\n?/g, "\n");
}

function packageDirectoryForInput(input, root) {
  const segments = input.replace(/\\/g, "/").split("/");
  const nodeModulesIndex = segments.lastIndexOf("node_modules");
  if (nodeModulesIndex === -1 || nodeModulesIndex + 1 >= segments.length) {
    return undefined;
  }
  const first = segments[nodeModulesIndex + 1];
  if (first === undefined || first === "") {
    return undefined;
  }
  const end = first.startsWith("@") ? nodeModulesIndex + 3 : nodeModulesIndex + 2;
  if (end > segments.length) {
    return undefined;
  }
  const location = segments.slice(0, end).join("/");
  return { location, absolute: path.resolve(root, location) };
}

function shippedTextFiles(directory, pattern) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map((entry) => ({
      name: entry.name,
      text: normalizeNewlines(fs.readFileSync(path.join(directory, entry.name), "utf8")),
    }));
}

function licenseLabel(license) {
  if (typeof license === "string" && license !== "") {
    return license;
  }
  if (license === undefined || license === null || license === "") {
    return "(no license field declared)";
  }
  return JSON.stringify(license);
}

function repositoryUrl(manifest) {
  const value = manifest.repository;
  if (typeof value === "string" && value !== "") {
    return value;
  }
  if (typeof value === "object" && value !== null && typeof value.url === "string") {
    return value.url;
  }
  return "(no repository URL declared)";
}

function readCopy(location, absolute) {
  let manifest = {};
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(absolute, "package.json"), "utf8"));
  } catch {
    manifest = {};
  }
  const name = typeof manifest.name === "string" && manifest.name !== "" ? manifest.name : path.basename(absolute);
  const version = typeof manifest.version === "string" && manifest.version !== "" ? manifest.version : "(unknown)";
  const license = manifest.license;
  const licenseFiles = shippedTextFiles(absolute, LICENSE_FILE_PATTERN);
  const noticeFiles = shippedTextFiles(absolute, NOTICE_FILE_PATTERN);
  const flags = [];
  if (licenseFiles.length === 0) {
    flags.push("NEEDS MAINTAINER REVIEW: no license text shipped");
  }
  if (license === undefined || license === null || license === "") {
    flags.push("NEEDS MAINTAINER REVIEW: no license field declared");
  } else if (typeof license !== "string") {
    flags.push("NEEDS MAINTAINER REVIEW: compound or non-string license field");
  } else {
    if (/\b(?:AND|OR|WITH)\b|\//.test(license)) {
      flags.push("NEEDS MAINTAINER REVIEW: compound license expression");
    }
    if (!REVIEWED_LICENSES.has(license)) {
      flags.push("NEEDS MAINTAINER REVIEW: license field outside reviewed set");
    }
  }
  return {
    name,
    version,
    location,
    license: licenseLabel(license),
    repository: repositoryUrl(manifest),
    licenseFiles,
    noticeFiles,
    flags,
  };
}

export function compareCopies(left, right) {
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  if (left.version !== right.version) return left.version < right.version ? -1 : 1;
  if (left.location !== right.location) return left.location < right.location ? -1 : 1;
  return 0;
}

export async function collectBundledCopies(root = DEFAULT_ROOT) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "third-party-notices-"));
  try {
    const result = await build({
      ...BUILD_OPTIONS,
      absWorkingDir: root,
      outfile: path.join(tmpDir, "dist", "index.js"),
      metafile: true,
    });
    if (result.metafile === undefined) {
      throw new Error("esbuild did not return a metafile");
    }
    const directories = new Map();
    for (const input of Object.keys(result.metafile.inputs)) {
      const directory = packageDirectoryForInput(input, root);
      if (directory !== undefined) {
        directories.set(directory.location, directory.absolute);
      }
    }
    return [...directories.entries()]
      .map(([location, absolute]) => readCopy(location, absolute))
      .sort(compareCopies);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function inventoryKeys(text) {
  const keys = [];
  for (const line of text.split("\n")) {
    const match = INVENTORY_LINE.exec(line.trimEnd());
    if (match?.[1] !== undefined) {
      keys.push(match[1]);
    }
  }
  return keys;
}

export async function generateNotices(root = DEFAULT_ROOT) {
  const copies = await collectBundledCopies(root);
  const groups = new Map();
  for (const copy of copies) {
    const group = groups.get(copy.license);
    if (group === undefined) groups.set(copy.license, [copy]);
    else group.push(copy);
  }

  const lines = [
    "THIRD-PARTY LICENSE NOTICES",
    "===========================",
    "",
    "Each installed package copy listed below contributed at least one input",
    "file to dist/index.js. The inventory is derived from esbuild's metafile for",
    "a fresh build, not from a package count or a source map. License and NOTICE",
    "texts are reproduced exactly as shipped, with line endings normalised to LF.",
    "No legal conclusion is drawn here. Entries marked NEEDS MAINTAINER REVIEW",
    "could not be resolved from the package files and are left for maintainer review.",
    "",
    `Bundled install copies: ${String(copies.length)}`,
    "",
    "Grouped by declared license. Within a group, entries are sorted by package",
    "name, then version, then install location.",
    "",
  ];

  for (const license of [...groups.keys()].sort()) {
    const group = groups.get(license).slice().sort(compareCopies);
    lines.push(`## LICENSE GROUP: ${license}`, "");
    for (const copy of group) {
      lines.push(
        `NOTICES-PACKAGE: ${copy.name}@${copy.version}`,
        `INSTALL LOCATION: ${copy.location}`,
        `DECLARED LICENSE: ${copy.license}`,
        `REPOSITORY: ${copy.repository}`,
      );
      if (copy.flags.length > 0) {
        lines.push(`FLAGS: ${copy.flags.join("; ")}`);
      }
      lines.push("");
      for (const file of [...copy.licenseFiles, ...copy.noticeFiles]) {
        lines.push(`--- BEGIN ${file.name} ---`, file.text.replace(/\n$/, ""), `--- END ${file.name} ---`, "");
      }
    }
  }

  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

const isDirectExecution =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectExecution) {
  const args = process.argv.slice(2);
  let outputPath = path.join(DEFAULT_ROOT, OUTPUT_FILE);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--stdout") {
      outputPath = undefined;
    } else if (arg === "--output" && args[index + 1] !== undefined) {
      index++;
      outputPath = path.resolve(args[index]);
    } else {
      console.error(`Unknown argument: ${String(arg)}`);
      process.exit(2);
    }
  }

  try {
    const notices = await generateNotices(DEFAULT_ROOT);
    if (outputPath === undefined) {
      process.stdout.write(notices);
    } else {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, notices, "utf8");
      console.log(`Wrote ${outputPath} (${String(inventoryKeys(notices).length)} bundled copies)`);
    }
  } catch (error) {
    console.error(`Failed to generate ${OUTPUT_FILE}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exit(1);
  }
}
