import { useQuery } from '@tanstack/react-query';
import { fetchNeedsReview, fetchNeedsReviewCount } from '../queries/atQueries';

export function useNeedsReview(allianceId) {
  return useQuery({
    queryKey: ['at', 'needs-review', allianceId],
    queryFn: () => fetchNeedsReview(allianceId),
    enabled: !!allianceId,
  });
}

export function useNeedsReviewCount(allianceId) {
  return useQuery({
    queryKey: ['at', 'needs-review-count', allianceId],
    queryFn: () => fetchNeedsReviewCount(allianceId),
    enabled: !!allianceId,
    // Drives the sidebar badge on every page — a minute of staleness is fine
    // and keeps navigation from re-querying constantly.
    staleTime: 1000 * 60,
  });
}
