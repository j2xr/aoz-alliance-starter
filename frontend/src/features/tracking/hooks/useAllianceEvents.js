import { useQuery } from '@tanstack/react-query';
import { fetchAllianceEvents, fetchAllianceEvent } from '../queries/atQueries';

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
