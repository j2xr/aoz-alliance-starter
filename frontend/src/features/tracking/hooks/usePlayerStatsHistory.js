import { useQuery } from '@tanstack/react-query';
import { fetchPlayerStatsHistory } from '../queries/atQueries';

export function usePlayerStatsHistory(allianceId, playerId) {
  return useQuery({
    queryKey: ['at', 'player-stats-history', allianceId, playerId],
    queryFn: () => fetchPlayerStatsHistory(allianceId, playerId),
    enabled: !!allianceId && !!playerId,
  });
}
