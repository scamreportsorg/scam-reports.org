"use client";

import { FormEvent, useEffect, useState } from "react";
import { AdminActionDialog, useAdminActionDialog } from "./admin/admin-action-dialog";
import { SafeLink } from "./safe-link";

type AccountItem = {
  id: string;
  handle: string;
  role: "member" | "moderator" | "admin";
  status: "active" | "suspended";
  createdAt: string;
  lastAuthenticatedAt: string | null;
  linkedProviders: { discord: boolean; email: boolean };
  contributions: { reviews: number; comments: number; reports: number };
};

type Page = {
  items: AccountItem[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
};

type Draft = Pick<AccountItem, "role" | "status">;

async function requestAccounts(page: number, query: string): Promise<Page> {
  const search = new URLSearchParams({ page: String(page), pageSize: "25" });
  if (query.trim()) search.set("q", query.trim());
  const response = await fetch(`/api/admin/accounts?${search}`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  const payload = (await response.json().catch(() => ({}))) as Page & {
    error?: string;
  };
  if (!response.ok) throw new Error(payload.error ?? "Couldn't load accounts.");
  return payload;
}

export function AdminAccountsPanel({ csrfToken }: { csrfToken: string }) {
  const actionDialog = useAdminActionDialog();
  const [result, setResult] = useState<Page | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [rowMessage, setRowMessage] = useState<{
    accountId: string;
    text: string;
    error: boolean;
    needsReconfirmation?: boolean;
  } | null>(null);

  function applyPage(payload: Page) {
    setResult(payload);
    setDrafts(
      Object.fromEntries(
        payload.items.map((item) => [
          item.id,
          {
            role: item.role,
            status: item.status,
          },
        ]),
      ),
    );
  }

  async function reload() {
    applyPage(await requestAccounts(page, query));
  }

  useEffect(() => {
    let cancelled = false;
    void requestAccounts(page, query)
      .then((payload) => {
        if (!cancelled) {
          setResult(payload);
          setDrafts(
            Object.fromEntries(
              payload.items.map((item) => [
                item.id,
                {
                  role: item.role,
                  status: item.status,
                },
              ]),
            ),
          );
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMessage(error instanceof Error ? error.message : "Couldn't load accounts.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [page, query]);

  function search(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setQuery(queryInput.trim());
  }

  async function save(item: AccountItem) {
    const draft = drafts[item.id] ?? item;
    setBusy(item.id);
    setMessage("");
    setRowMessage(null);
    try {
      const response = await fetch("/api/admin/accounts", {
        method: "PATCH",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify({
          id: item.id,
          role: draft.role,
          status: draft.status,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
      };
      if (!response.ok) {
        setRowMessage({
          accountId: item.id,
          text: payload.error ?? "Couldn't update the account.",
          error: true,
          needsReconfirmation: payload.code === "dual_confirmation_required",
        });
        return;
      }
      setRowMessage({
        accountId: item.id,
        text: `${item.handle} is now ${draft.role} and ${draft.status}.`,
        error: false,
      });
      await reload();
    } catch (error) {
      const text = error instanceof Error ? error.message : "Couldn't update the account.";
      setRowMessage({
        accountId: item.id,
        text,
        error: true,
      });
    } finally {
      setBusy(null);
    }
  }

  async function remove(item: AccountItem) {
    const confirmed = await actionDialog.confirm({
      eyebrow: "Permanent action",
      title: "Delete account",
      description: `Permanently delete ${item.handle}?`,
      details: [
        "This cannot be undone.",
        "You still need a fresh admin session and recent confirmation from both providers.",
      ],
      confirmLabel: "Delete account",
      tone: "danger",
    });
    if (!confirmed) return;

    setBusy(item.id);
    setMessage("");
    try {
      const response = await fetch(`/api/admin/accounts?id=${encodeURIComponent(item.id)}`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "x-csrf-token": csrfToken },
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error ?? "Couldn't delete the account.");
      setMessage(`Deleted ${item.handle}.`);
      await reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Couldn't delete the account.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="forum-box admin-accounts-panel">
      <div className="forum-box-title">
        <h2>Accounts and roles</h2>
        <span>{result?.pagination.totalItems ?? 0} accounts</span>
      </div>
      <div className="admin-section-body">
        <p className="thread-notice">
          Changing a role or status, or deleting an account, needs a fresh admin session and both
          providers confirmed within ten minutes. Changes are logged and sign that account out
          everywhere. The last active admin is protected.
        </p>
        <form className="directory-search compact-admin-search" onSubmit={search}>
          <label>
            Find account
            <input
              value={queryInput}
              onChange={(event) => setQueryInput(event.target.value)}
              maxLength={100}
              placeholder="Handle or exact account ID"
            />
          </label>
          <button className="forum-button" type="submit">
            Search
          </button>
        </form>
        {message && (
          <p className="admin-inline-message" role="status">
            {message}
          </p>
        )}
        <div className="table-scroll">
          <table className="admin-account-table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Providers</th>
                <th>Contributions</th>
                <th>Role</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {(result?.items ?? []).map((item) => {
                const draft = drafts[item.id] ?? item;
                const changed = draft.role !== item.role || draft.status !== item.status;
                return (
                  <tr className={changed ? "admin-account-row-changed" : undefined} key={item.id}>
                    <td data-label="Account">
                      <strong>{item.handle}</strong>
                      <small>
                        {item.id}
                        <br />
                        Joined {item.createdAt.slice(0, 10)}
                      </small>
                    </td>
                    <td data-label="Providers">
                      {item.linkedProviders.discord ? "Discord ✓" : "Discord not linked"}
                      <br />
                      {item.linkedProviders.email ? "Email ✓" : "Email not linked"}
                    </td>
                    <td data-label="Contributions">
                      {item.contributions.reports} reports · {item.contributions.reviews} reviews ·{" "}
                      {item.contributions.comments} comments
                    </td>
                    <td data-label="Role">
                      <select
                        aria-label={`Role for ${item.handle}`}
                        className={`admin-account-select admin-role-${draft.role}`}
                        value={draft.role}
                        disabled={busy === item.id}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [item.id]: {
                              ...draft,
                              role: event.target.value as Draft["role"],
                            },
                          }))
                        }
                      >
                        <option value="member">Member</option>
                        <option value="moderator">Moderator</option>
                        <option value="admin">Admin</option>
                      </select>
                    </td>
                    <td data-label="Status">
                      <select
                        aria-label={`Status for ${item.handle}`}
                        className={`admin-account-select admin-status-${draft.status}`}
                        value={draft.status}
                        disabled={busy === item.id}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [item.id]: {
                              ...draft,
                              status: event.target.value as Draft["status"],
                            },
                          }))
                        }
                      >
                        <option value="active">Active</option>
                        <option value="suspended">Suspended</option>
                      </select>
                    </td>
                    <td className="admin-account-actions" data-label="Actions">
                      <button
                        className="forum-button"
                        type="button"
                        disabled={!changed || busy === item.id}
                        onClick={() => void save(item)}
                      >
                        {busy === item.id ? "Saving…" : changed ? "Save changes" : "Saved"}
                      </button>
                      <button
                        className="forum-button danger"
                        type="button"
                        disabled={busy === item.id}
                        onClick={() => void remove(item)}
                      >
                        Delete
                      </button>
                      {rowMessage?.accountId === item.id && (
                        <div
                          className={
                            rowMessage.error
                              ? "admin-account-row-message error"
                              : "admin-account-row-message success"
                          }
                          role={rowMessage.error ? "alert" : "status"}
                        >
                          {rowMessage.text}
                          {rowMessage.needsReconfirmation && (
                            <SafeLink href="/account?notice=reconfirm-required">
                              Reconfirm Discord and email
                            </SafeLink>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {result && result.pagination.totalPages > 1 && (
          <nav className="pagination" aria-label="Account pages">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              ← Previous
            </button>
            <span>
              Page {result.pagination.page} of {result.pagination.totalPages}
            </span>
            <button
              type="button"
              disabled={page >= result.pagination.totalPages}
              onClick={() => setPage((current) => current + 1)}
            >
              Next →
            </button>
          </nav>
        )}
      </div>
      <AdminActionDialog controller={actionDialog} />
    </section>
  );
}
