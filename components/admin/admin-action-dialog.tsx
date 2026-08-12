"use client";

import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

type DialogTone = "standard" | "danger";

export type AdminDialogField = {
  name: string;
  label: string;
  initialValue?: string;
  help?: string;
  placeholder?: string;
  required?: boolean;
  multiline?: boolean;
  maxLength?: number;
};

type DialogCopy = {
  title: string;
  description: string;
  confirmLabel: string;
  eyebrow?: string;
  cancelLabel?: string;
  details?: string[];
  tone?: DialogTone;
};

export type AdminConfirmationRequest = DialogCopy;

export type AdminFormRequest = DialogCopy & {
  fields: AdminDialogField[];
};

type DialogRequest = DialogCopy & {
  id: number;
  fields: AdminDialogField[];
};

type DialogResult = Record<string, string> | null;

export function useAdminActionDialog() {
  const [request, setRequest] = useState<DialogRequest | null>(null);
  const resolver = useRef<((result: DialogResult) => void) | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const sequence = useRef(0);

  const finish = useCallback((result: DialogResult) => {
    const resolve = resolver.current;
    resolver.current = null;
    setRequest(null);
    resolve?.(result);

    window.requestAnimationFrame(() => {
      if (resolver.current) return;
      returnFocus.current?.focus();
      returnFocus.current = null;
    });
  }, []);

  const open = useCallback((next: Omit<DialogRequest, "id">) => {
    resolver.current?.(null);
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && !activeElement.closest(".admin-action-dialog")) {
      returnFocus.current = activeElement;
    }

    return new Promise<DialogResult>((resolve) => {
      resolver.current = resolve;
      sequence.current += 1;
      setRequest({ ...next, id: sequence.current });
    });
  }, []);

  const confirm = useCallback(
    async (options: AdminConfirmationRequest) => (await open({ ...options, fields: [] })) !== null,
    [open],
  );

  const collect = useCallback((options: AdminFormRequest) => open(options), [open]);

  useEffect(
    () => () => {
      resolver.current?.(null);
      resolver.current = null;
    },
    [],
  );

  return { request, confirm, collect, cancel: () => finish(null), finish };
}

export type AdminActionDialogController = ReturnType<typeof useAdminActionDialog>;

export function AdminActionDialog({ controller }: { controller: AdminActionDialogController }) {
  if (!controller.request) return null;

  return (
    <AdminActionDialogFrame
      key={controller.request.id}
      request={controller.request}
      onCancel={controller.cancel}
      onSubmit={controller.finish}
    />
  );
}

function AdminActionDialogFrame({
  request,
  onCancel,
  onSubmit,
}: {
  request: DialogRequest;
  onCancel: () => void;
  onSubmit: (values: Record<string, string>) => void;
}) {
  const headingId = useId();
  const descriptionId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(request.fields.map((field) => [field.name, field.initialValue ?? ""])),
  );

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const firstField = panel.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      "input, textarea",
    );
    (firstField ?? cancelButton.current)?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(values);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = Array.from(
      panel.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((element) => element.getClientRects().length > 0);
    if (!focusable.length) return;

    const first = focusable[0];
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="admin-action-backdrop">
      <div
        ref={panel}
        className={`admin-action-dialog admin-action-dialog-${request.tone ?? "standard"}`}
        role={request.tone === "danger" ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={descriptionId}
        onKeyDown={handleKeyDown}
      >
        <div className="admin-action-dialog-titlebar">
          <div>
            <small>{request.eyebrow ?? "Moderator action"}</small>
            <h2 id={headingId}>{request.title}</h2>
          </div>
          <button type="button" onClick={onCancel} aria-label="Close dialog">
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="admin-action-dialog-body">
            <p id={descriptionId}>{request.description}</p>

            {request.details?.length ? (
              <ul className="admin-action-dialog-details">
                {request.details.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
            ) : null}

            {request.fields.map((field) => {
              const fieldId = `${headingId}-${field.name}`;
              const helpId = field.help ? `${fieldId}-help` : undefined;
              const common = {
                id: fieldId,
                name: field.name,
                value: values[field.name] ?? "",
                required: field.required,
                maxLength: field.maxLength,
                placeholder: field.placeholder,
                "aria-describedby": helpId,
                onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
                  setValues((current) => ({
                    ...current,
                    [field.name]: event.target.value,
                  })),
              };

              return (
                <label className="admin-action-dialog-field" key={field.name} htmlFor={fieldId}>
                  <span>
                    {field.label}
                    {field.required ? " *" : ""}
                  </span>
                  {field.multiline ? <textarea {...common} rows={5} /> : <input {...common} />}
                  {field.help ? <small id={helpId}>{field.help}</small> : null}
                </label>
              );
            })}
          </div>

          <div className="admin-action-dialog-footer">
            <button ref={cancelButton} type="button" onClick={onCancel}>
              {request.cancelLabel ?? "Cancel"}
            </button>
            <button
              className={request.tone === "danger" ? "danger-action" : undefined}
              type="submit"
            >
              {request.confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
