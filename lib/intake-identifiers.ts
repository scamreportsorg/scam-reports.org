export type IntakePrefix = "SUB" | "APL" | "COM";

export function createIntakeId(prefix: IntakePrefix) {
  return `${prefix}-${new Date().getUTCFullYear()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

export async function allocateUniqueIntakeId(
  prefix: IntakePrefix,
  exists: (id: string) => Promise<boolean>,
  createId: (prefix: IntakePrefix) => string = createIntakeId,
) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = createId(prefix);
    if (!(await exists(id))) return id;
  }
  throw new Error("Unable to allocate an intake identifier.");
}
