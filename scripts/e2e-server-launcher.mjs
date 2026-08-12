#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const readyLine = "Local E2E worker listening on ";
const windowsStackBufferOverrun = new Set([3221226505, -1073740791]);

export function shouldRetryE2eServerStart({ attempt, code, platform, ready }) {
  return (
    platform === "win32" && attempt === 0 && !ready && windowsStackBufferOverrun.has(code ?? 0)
  );
}

function exitStatus(code) {
  return Number.isInteger(code) && code >= 0 && code <= 255 ? code : 1;
}

function main() {
  const serverArguments = process.argv.slice(2);
  let attempt = 0;
  let child;
  let stopping = false;

  const launch = () => {
    let ready = false;
    let outputTail = "";
    child = spawn(process.execPath, ["tests/e2e/server.mjs", ...serverArguments], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      outputTail = `${outputTail}${chunk}`.slice(-512);
      if (outputTail.includes(readyLine)) ready = true;
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.once("error", (error) => {
      console.error(`Unable to start the local E2E server: ${error.message}`);
    });
    child.once("exit", (code, signal) => {
      if (stopping) {
        process.exit(0);
      }
      if (shouldRetryE2eServerStart({ attempt, code, platform: process.platform, ready })) {
        attempt += 1;
        console.error("Local workerd crashed before startup; retrying once.");
        setTimeout(launch, 250);
        return;
      }
      if (signal) console.error(`Local E2E server stopped with signal ${signal}.`);
      process.exit(exitStatus(code));
    });
  };

  const stop = (signal) => {
    stopping = true;
    if (child && !child.killed) child.kill(signal);
    else process.exit(0);
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  launch();
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) main();
