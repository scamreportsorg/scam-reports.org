import { SafeLink as Link } from "./safe-link";

export function Breadcrumbs({ items }: { items: Array<{ label: string; href?: string }> }) {
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      <Link href="/">Scam-Reports.org</Link>
      {items.map((item) => (
        <span key={`${item.href}-${item.label}`}>
          <span aria-hidden="true">›</span>
          {item.href ? <Link href={item.href}>{item.label}</Link> : <b>{item.label}</b>}
        </span>
      ))}
    </nav>
  );
}
