import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "release");

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Release directory contains a symbolic link: ${path}`);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (entry.isFile() && entry.name !== "SHA256SUMS") result.push(path);
  }
  return result;
}

const lines = [];
for (const path of await files(root)) {
  const digest = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  lines.push(`${digest}  ${relative(root, path).replaceAll("\\", "/")}`);
}
if (!lines.length) throw new Error("Release directory contains no files to hash.");
await writeFile(resolve(root, "SHA256SUMS"), `${lines.join("\n")}\n`, {
  encoding: "utf8",
  mode: 0o644,
});
console.log(`Wrote ${lines.length} SHA-256 entries to ${resolve(root, "SHA256SUMS")}`);
