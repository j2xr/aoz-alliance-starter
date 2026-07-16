import { useQuery } from '@tanstack/react-query';
import { fetchAllianceEvents } from '../queries/atQueries';

export function useAllianceEvents(allianceId, limit = 20) {
  return useQuery({
    queryKey: ['at', 'events', allianceId, limit],
    queryFn: () => fetchAllianceEvents(allianceId, limit),
    enabled: !!allianceId,
  });
}
