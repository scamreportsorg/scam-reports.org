import { SafeLink as Link } from "@/components/safe-link";
import { SiteShell } from "@/components/site-shell";

export default function NotFound() {
  return (
    <SiteShell>
      <section className="forum-box missing-record">
        <h1>404: Thread not found</h1>
        <p>This page doesn&apos;t exist, or the thread was archived.</p>
        <Link className="forum-button" href="/">
          Back to the forum
        </Link>
      </section>
    </SiteShell>
  );
}
