import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const exporter = fileURLToPath(new URL("../scripts/export-public-root.mjs", import.meta.url));

function git(directory, ...args) {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8" });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "scam-reports-public-export-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const unusualMissingPath = "missing-\u202e--execute-lookalike.txt";
  await mkdir(join(source, "bin"), { recursive: true });
  await Promise.all([
    writeFile(join(source, ".gitignore"), "ignored.local\nexport-inside/\n"),
    writeFile(join(source, "tracked.bin"), Buffer.from([0, 1, 2, 3, 255])),
    writeFile(join(source, "deleted.txt"), "remove me\n"),
    writeFile(join(source, unusualMissingPath), "remove this safely too\n"),
    writeFile(join(source, "bin", "run.sh"), "#!/bin/sh\nexit 0\n"),
    writeFile(join(source, "ignored.local"), "not public\n"),
  ]);
  if (process.platform !== "win32") await chmod(join(source, "bin", "run.sh"), 0o755);

  git(source, "init", "--quiet", "--initial-branch=main");
  git(source, "config", "user.name", "Export Test");
  git(source, "config", "user.email", "export-test@example.test");
  git(source, "config", "core.autocrlf", "false");
  git(source, "add", ".gitignore", "tracked.bin", "deleted.txt", unusualMissingPath, "bin/run.sh");
  git(source, "commit", "--quiet", "-m", "fixture");
  await Promise.all([rm(join(source, "deleted.txt")), rm(join(source, unusualMissingPath))]);
  await writeFile(join(source, "new.txt"), "untracked but public\n");
  await writeFile(join(source, ".git", "private-marker"), "git metadata\n");
  return { root, source, unusualMissingPath };
}

function run(source, target, ...options) {
  return spawnSync(
    process.execPath,
    [exporter, "--source", source, "--target", target, ...options],
    { encoding: "utf8" },
  );
}

async function allFiles(directory, prefix = "") {
  const files = [];
  for (const name of await readdir(directory)) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const path = join(directory, name);
    const stats = await lstat(path);
    if (stats.isDirectory()) files.push(...(await allFiles(path, relative)));
    else files.push(relative);
  }
  return files.sort();
}

test("public-root export defaults to dry run", async (t) => {
  const { root, source } = await fixture(t);
  const target = join(root, "dry-run");
  const result = run(source, target);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Mode: dry-run/u);
  assert.match(result.stdout, /Nothing was copied/u);
  assert.match(result.stdout, /Missing: 2 tracked path/u);
  assert.match(result.stdout, /^- "deleted\.txt"$/mu);
  assert.match(result.stdout, /^- "missing-\\u202e--execute-lookalike\.txt"$/mu);
  assert.doesNotMatch(result.stdout, /\u202e/u);
  assert.match(result.stdout, /execute will refuse without --allow-missing/u);
  assert.doesNotMatch(result.stdout, /ignored\.local/u);
  assert.doesNotMatch(result.stdout, /private-marker/u);
  await assert.rejects(lstat(target), { code: "ENOENT" });
});

test("public-root export rejects missing files", async (t) => {
  const { root, source } = await fixture(t);
  const target = join(root, "refused");
  const result = run(source, target, "--execute");

  assert.equal(result.status, 1);
  assert.match(result.stdout, /^- "deleted\.txt"$/mu);
  assert.match(result.stdout, /^- "missing-\\u202e--execute-lookalike\.txt"$/mu);
  assert.doesNotMatch(result.stdout, /\u202e/u);
  assert.match(result.stderr, /refusing to execute because 2 tracked path/u);
  assert.match(result.stderr, /use --allow-missing only when every omission is intentional/u);
  await assert.rejects(lstat(target), { code: "ENOENT" });
});

test("public-root export copies selected bytes", async (t) => {
  const { root, source } = await fixture(t);
  const target = join(root, "exported");
  const result = run(source, target, "--execute", "--allow-missing");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Allowed omissions:/u);
  assert.match(result.stdout, /^- "deleted\.txt"$/mu);
  assert.match(result.stdout, /^- "missing-\\u202e--execute-lookalike\.txt"$/mu);
  assert.doesNotMatch(result.stdout, /\u202e/u);
  assert.match(result.stdout, /2 omission\(s\) explicitly allowed by --allow-missing/u);
  assert.match(result.stdout, /Git history and \.git metadata were not exported/u);
  assert.deepEqual(await readFile(join(target, "tracked.bin")), Buffer.from([0, 1, 2, 3, 255]));
  assert.equal(await readFile(join(target, "new.txt"), "utf8"), "untracked but public\n");
  assert.deepEqual(await allFiles(target), [".gitignore", "bin/run.sh", "new.txt", "tracked.bin"]);
  await assert.rejects(lstat(join(target, ".git")), { code: "ENOENT" });

  if (process.platform !== "win32") {
    const sourceMode = (await lstat(join(source, "bin", "run.sh"))).mode & 0o111;
    const targetMode = (await lstat(join(target, "bin", "run.sh"))).mode & 0o111;
    assert.equal(targetMode, sourceMode);
  }
});

test("public-root export accepts an empty target", async (t) => {
  const { root, source } = await fixture(t);
  const target = join(root, "empty");
  await mkdir(target);

  const result = run(source, target, "--execute", "--allow-missing");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(target, "new.txt"), "utf8"), "untracked but public\n");
});

test("public-root export leaves nonempty targets alone", async (t) => {
  const { root, source } = await fixture(t);
  const target = join(root, "occupied");
  await mkdir(target);
  await writeFile(join(target, "keep.txt"), "keep\n");

  const result = run(source, target, "--execute");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must not exist or must be empty/u);
  assert.deepEqual(await allFiles(target), ["keep.txt"]);
  assert.equal(await readFile(join(target, "keep.txt"), "utf8"), "keep\n");
});

test("public-root export rejects nested targets", async (t) => {
  const { source } = await fixture(t);
  const target = join(source, "export-inside");

  const result = run(source, target, "--execute");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot be the source directory or live inside it/u);
  await assert.rejects(lstat(target), { code: "ENOENT" });
});

test("public-root export avoids Git metadata", async (t) => {
  const { root, source } = await fixture(t);
  const metadata = join(root, "other", ".git");
  const target = join(metadata, "export");
  await mkdir(metadata, { recursive: true });

  const result = run(source, target, "--execute");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot be inside Git metadata/u);
  await assert.rejects(lstat(target), { code: "ENOENT" });
});

test("public-root export rejects needless overrides", async (t) => {
  const { root, source } = await fixture(t);
  git(source, "restore", "deleted.txt", "missing-\u202e--execute-lookalike.txt");
  const target = join(root, "no-missing");

  const result = run(source, target, "--execute", "--allow-missing");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unnecessary --allow-missing/u);
  await assert.rejects(lstat(target), { code: "ENOENT" });
});
