"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { SafeLink as Link } from "./safe-link";

const navigation = [
  ["Home", "/"],
  ["Reports", "/#database"],
  ["Reputation", "/rankings"],
  ["Submit", "/submit"],
  ["Stats", "/statistics"],
  ["Community", "/community"],
  ["Rules", "/rules"],
  ["Appeals", "/appeals"],
] as const;

function currentItem(href: string, pathname: string, hash: string) {
  if (href === "/") return pathname === "/" && hash !== "#database";
  if (href === "/#database") {
    return (
      pathname === "/reports" ||
      pathname.startsWith("/reports/") ||
      (pathname === "/" && hash === "#database")
    );
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function PrimaryNavigation() {
  const pathname = usePathname();
  const [hash, setHash] = useState("");

  useEffect(() => {
    const update = () => setHash(window.location.hash);
    update();
    window.addEventListener("hashchange", update);
    window.addEventListener("popstate", update);
    return () => {
      window.removeEventListener("hashchange", update);
      window.removeEventListener("popstate", update);
    };
  }, [pathname]);

  return (
    <div className="site-width nav-links">
      {navigation.map(([label, href]) => (
        <Link
          aria-current={currentItem(href, pathname, hash) ? "page" : undefined}
          href={href}
          key={href}
        >
          {label}
        </Link>
      ))}
    </div>
  );
}
