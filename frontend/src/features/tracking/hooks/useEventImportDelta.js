import { useQuery } from '@tanstack/react-query';
import { fetchEventImportDelta, fetchAllianceImportDeltas } from '../queries/atQueries';

export function useEventImportDelta(eventId) {
  return useQuery({
    queryKey: ['at', 'event-import-delta', eventId],
    queryFn: () => fetchEventImportDelta(eventId),
    enabled: !!eventId,
  });
}

export function useAllianceImportDeltas(allianceId) {
  return useQuery({
    queryKey: ['at', 'alliance-import-deltas', allianceId],
    queryFn: () => fetchAllianceImportDeltas(allianceId),
    enabled: !!allianceId,
  });
}
