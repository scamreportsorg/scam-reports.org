import { SafeLink as Link } from "./safe-link";
import { exactSourceUrl, getPublicVersion } from "@/lib/version";

export function ForumFooter() {
  const version = getPublicVersion();
  return (
    <footer className="forum-footer">
      <div className="site-width footer-grid">
        <div>
          <strong>Scam-Reports.org</strong>
          <p>
            Independent archive for community reports. Not affiliated with Discord, publishers,
            platforms or anti-cheat vendors.
          </p>
        </div>
        <div className="footer-links">
          <Link href="/rules">Rules</Link>
          <Link href="/appeals">Corrections & Appeals</Link>
          <Link href="/submit">Submit Evidence</Link>
          <Link href="/community">Community &amp; Open Source</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/security">Security</Link>
          <Link href="/admin">Admin</Link>
          {version.sourceAvailable && (
            <a href={exactSourceUrl(version)} rel="noreferrer">
              Source code
            </a>
          )}
        </div>
      </div>
      <div className="site-width footer-legal">
        <span>
          Unconfirmed reports are allegations. Nothing should go public before privacy and source
          checks.
        </span>
        <span>
          AGPL-3.0-or-later · {version.version} ·{" "}
          {version.sourceAvailable ? (
            <a href={exactSourceUrl(version)} rel="noreferrer">
              {version.commit.slice(0, 12)}
            </a>
          ) : (
            <span>{version.commit.slice(0, 12)}</span>
          )}{" "}
          · built {version.buildTime}
          {version.sourceAvailable && (
            <>
              {" "}
              ·{" "}
              <a href={version.sourceArchiveUrl} rel="noreferrer">
                source archive
              </a>
            </>
          )}{" "}
          · schema {version.schemaVersion}
        </span>
      </div>
    </footer>
  );
}
