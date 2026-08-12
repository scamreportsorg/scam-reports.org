"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import type { EvidenceAttachment } from "@/lib/types";
import { formatDate, formatFileSize } from "@/lib/format";

export function EvidenceGallery({ evidence }: { evidence: EvidenceAttachment[] }) {
  const [active, setActive] = useState<EvidenceAttachment | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!active) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setActive(null);
      } else if (event.key === "Tab") {
        event.preventDefault();
        closeButton.current?.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      opener.current?.focus();
    };
  }, [active]);

  if (!evidence.length) {
    return <div className="empty-evidence">No public evidence files for this report.</div>;
  }

  return (
    <>
      <div className="evidence-grid">
        {evidence.map((item) => (
          <article className="attachment" key={item.id}>
            <button
              className="attachment-preview"
              onClick={(event) => {
                if (!item.url || item.redacted) return;
                opener.current = event.currentTarget;
                setActive(item);
              }}
              disabled={!item.url || item.redacted}
              aria-label={item.redacted ? `${item.filename} is redacted` : `Open ${item.filename}`}
            >
              {item.url && !item.redacted ? (
                <Image src={item.url} alt={item.caption} width={720} height={450} unoptimized />
              ) : (
                <span className="redacted-placeholder">
                  <b>REDACTED</b>
                  <small>Not shown publicly</small>
                </span>
              )}
            </button>
            <div className="attachment-meta">
              <strong>{item.filename}</strong>
              <span>
                {formatFileSize(item.fileSize)} · {formatDate(item.uploadedAt)}
              </span>
              <p>{item.caption}</p>
            </div>
          </article>
        ))}
      </div>
      {active && active.url && (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label="Evidence preview">
          <button ref={closeButton} className="lightbox-close" onClick={() => setActive(null)}>
            Close ×
          </button>
          <Image src={active.url} alt={active.caption} width={1400} height={900} unoptimized />
          <p>{active.caption}</p>
        </div>
      )}
    </>
  );
}
