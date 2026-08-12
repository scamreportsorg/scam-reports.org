import { AuthError } from "./auth-errors";
import { BoundedFormError, readBoundedUrlEncodedForm } from "./bounded-form";
import { BoundedJsonError, readBoundedJson } from "./bounded-json";

function authBodyError(error: BoundedFormError | BoundedJsonError) {
  const code = error.code === "unsupported_media_type" ? "invalid_content_type" : error.code;
  return new AuthError(error.status, code, error.message);
}

export async function readAuthJson(request: Request, maximumBytes: number) {
  try {
    return await readBoundedJson(request, maximumBytes);
  } catch (error) {
    if (error instanceof BoundedJsonError) throw authBodyError(error);
    throw error;
  }
}

export async function readAuthForm(request: Request, maximumBytes: number) {
  try {
    return await readBoundedUrlEncodedForm(request, maximumBytes);
  } catch (error) {
    if (error instanceof BoundedFormError) throw authBodyError(error);
    throw error;
  }
}
