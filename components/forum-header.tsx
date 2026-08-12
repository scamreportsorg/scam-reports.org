import Image from "next/image";
import { PrimaryNavigation } from "./primary-navigation";
import { SafeLink as Link } from "./safe-link";

export function ForumHeader() {
  return (
    <>
      <div className="utility-bar">
        <div className="site-width utility-inner">
          <span>Welcome to Scam-Reports.org</span>
          <span className="utility-links">
            <Link href="/account">Account</Link>
            <span aria-hidden="true">·</span>
            <Link href="/rules">Rules</Link>
            <span aria-hidden="true">·</span>
            <Link href="/admin">Staff</Link>
          </span>
        </div>
      </div>
      <header className="site-header">
        <div className="site-width brand-row">
          <Link aria-label="Scam-Reports.org home" className="brand brand-wordmark" href="/">
            <Image
              src="/brand/scam-reports-wordmark.webp"
              alt=""
              width={760}
              height={138}
              sizes="(max-width: 680px) 92vw, 390px"
              priority
              unoptimized
            />
          </Link>
          <form className="header-search" action="/" role="search">
            <label htmlFor="header-search">Search the archive</label>
            <div>
              <input id="header-search" name="q" placeholder="Username or Discord ID" />
              <button type="submit">Search</button>
            </div>
          </form>
        </div>
        <nav className="main-nav" aria-label="Primary navigation">
          <PrimaryNavigation />
        </nav>
      </header>
    </>
  );
}
