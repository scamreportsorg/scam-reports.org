import type { QueuePagination } from "./moderation-queue-types";

type QueuePaginationProps = {
  pagination: QueuePagination;
  loading: boolean;
  label: string;
  itemName: string;
  onPageChange: (page: number) => void;
};

export function QueuePaginationControls({
  pagination,
  loading,
  label,
  itemName,
  onPageChange,
}: QueuePaginationProps) {
  if (pagination.totalPages <= 1) return null;

  return (
    <div className="directory-pagination" aria-label={label}>
      <button
        disabled={loading || pagination.page <= 1}
        onClick={() => onPageChange(pagination.page - 1)}
      >
        Previous
      </button>
      <span>
        Page {pagination.page} of {pagination.totalPages} · {pagination.totalItems} {itemName}
      </span>
      <button
        disabled={loading || pagination.page >= pagination.totalPages}
        onClick={() => onPageChange(pagination.page + 1)}
      >
        Next
      </button>
    </div>
  );
}
