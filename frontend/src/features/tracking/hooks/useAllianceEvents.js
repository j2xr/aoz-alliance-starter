import { useQuery } from '@tanstack/react-query';
import { fetchAllianceEvents, fetchAllianceEvent, fetchAllianceEventCount } from '../queries/atQueries';

export function useAllianceEvents(allianceId, limit = 20) {
  return useQuery({
    queryKey: ['at', 'events', allianceId, limit],
    queryFn: () => fetchAllianceEvents(allianceId, limit),
    enabled: !!allianceId,
  });
}

export function useAllianceEvent(eventId) {
  return useQuery({
    queryKey: ['at', 'event', eventId],
    queryFn: () => fetchAllianceEvent(eventId),
    enabled: !!eventId,
  });
}

// Count of alliance events since `sinceIso`. Naturally skipped when sinceIso is
// null (the 'all' period), so the all-time view pays for no extra query.
export function useAllianceEventCount(allianceId, sinceIso) {
  return useQuery({
    queryKey: ['at', 'event-count', allianceId, sinceIso],
    queryFn: () => fetchAllianceEventCount(allianceId, sinceIso),
    enabled: !!allianceId && !!sinceIso,
  });
}
