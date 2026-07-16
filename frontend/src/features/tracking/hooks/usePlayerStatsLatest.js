import { useQuery } from '@tanstack/react-query';
import { fetchPlayerStatsLatest } from '../queries/atQueries';

export function usePlayerStatsLatest(allianceId) {
  return useQuery({
    queryKey: ['at', 'player-stats-latest', allianceId],
    queryFn: () => fetchPlayerStatsLatest(allianceId),
    enabled: !!allianceId,
  });
}
