"use client";

import { ForumHeader } from "@/components/forum-header";
import { SafeLink as Link } from "@/components/safe-link";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="page-shell">
      <ForumHeader />
      <main className="site-width site-main">
        <section className="forum-box admin-login">
          <div className="forum-box-title">
            <h1>Something broke</h1>
            <span>Try again shortly</span>
          </div>
          <div className="forum-box-body prose-block">
            <h2>This page didn&apos;t load</h2>
            <p>Try again. If it keeps happening, send us the URL and we&apos;ll take a look.</p>
            {error.digest && <small>Reference: {error.digest}</small>}
            <div className="thread-actions">
              <button className="forum-button" type="button" onClick={reset}>
                Try again
              </button>
              <Link className="forum-button subtle" href="/">
                Back to the archive
              </Link>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
