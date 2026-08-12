import assert from "node:assert/strict";
import test from "node:test";
import {
  EVIDENCE_ACCEPT,
  EVIDENCE_ACCEPTED_TYPES,
  EVIDENCE_UPLOAD_LIMITS,
  validateEvidenceFiles,
} from "../lib/evidence-constraints.ts";

function image(name, type = "image/png", size = 1024) {
  return { name, type, size };
}

test("client limits match the upload contract", () => {
  assert.deepEqual(EVIDENCE_ACCEPTED_TYPES, ["image/png", "image/jpeg", "image/webp"]);
  assert.equal(EVIDENCE_ACCEPT, "image/png,image/jpeg,image/webp");
  assert.deepEqual(EVIDENCE_UPLOAD_LIMITS, {
    maxFiles: 5,
    maxFileSize: 5 * 1024 * 1024,
    maxTotalSize: 20 * 1024 * 1024,
  });
});

test("client validation accepts boundary values", () => {
  assert.equal(
    validateEvidenceFiles(Array.from({ length: 5 }, (_, index) => image(`small-${index}.png`))),
    "",
  );
  const files = Array.from({ length: 4 }, (_, index) =>
    image(`evidence-${index}.png`, "image/png", 5 * 1024 * 1024),
  );
  assert.equal(validateEvidenceFiles(files), "");
  assert.equal(validateEvidenceFiles([image("photo.jpg", "image/jpeg", 5 * 1024 * 1024)]), "");
  assert.equal(validateEvidenceFiles([image("capture.webp", "image/webp")]), "");
});

test("client validation keeps its error messages", () => {
  assert.equal(
    validateEvidenceFiles(Array.from({ length: 6 }, (_, index) => image(`${index}.png`))),
    "Select no more than 5 images.",
  );
  assert.equal(
    validateEvidenceFiles([image("notes.txt", "text/plain")]),
    "notes.txt is not a PNG, JPEG, or WebP image.",
  );
  assert.equal(
    validateEvidenceFiles([image("large.png", "image/png", 5 * 1024 * 1024 + 1)]),
    "large.png is larger than 5 MB.",
  );
  assert.equal(
    validateEvidenceFiles([
      image("first.png", "image/png", 5 * 1024 * 1024),
      image("second.png", "image/png", 5 * 1024 * 1024),
      image("third.png", "image/png", 5 * 1024 * 1024),
      image("fourth.png", "image/png", 5 * 1024 * 1024),
      image("extra.png", "image/png", 1),
    ]),
    "The selected files are larger than 20 MB in total.",
  );
});
