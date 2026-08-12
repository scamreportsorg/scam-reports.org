import type { ReactNode } from "react";
import { ForumFooter } from "./forum-footer";
import { ForumHeader } from "./forum-header";

export function SiteShell({ children }: { children: ReactNode }) {
  return (
    <div className="page-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <ForumHeader />
      <main className="site-width site-main" id="main-content" tabIndex={-1}>
        {children}
      </main>
      <ForumFooter />
    </div>
  );
}
