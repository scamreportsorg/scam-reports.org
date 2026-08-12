import type { AnchorHTMLAttributes, ReactNode } from "react";

type SafeLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
  children: ReactNode;
};

export function SafeLink({ href, children, ...props }: SafeLinkProps) {
  return (
    <a href={href} {...props}>
      {children}
    </a>
  );
}
