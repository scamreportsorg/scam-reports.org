import type { ReactNode } from "react";

export function SectionBox({
  title,
  children,
  className = "",
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`forum-box ${className}`}>
      <h2 className="forum-box-title">{title}</h2>
      <div className="forum-box-body">{children}</div>
    </section>
  );
}
