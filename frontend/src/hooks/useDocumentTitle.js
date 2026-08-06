import { useEffect } from 'react';

/** Sets document.title while mounted, restoring the previous title on unmount/change. */
export function useDocumentTitle(title) {
  useEffect(() => {
    if (!title) return;
    const prev = document.title;
    document.title = title;
    return () => { document.title = prev; };
  }, [title]);
}
