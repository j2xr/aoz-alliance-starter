import { useQuery } from '@tanstack/react-query';
import { fetchPlayerStats, fetchAlliancePlayer } from '../queries/atQueries';

export function usePlayerStats(playerId, allianceId) {
  return useQuery({
    queryKey: ['at', 'player-stats', playerId, allianceId],
    queryFn: () => fetchPlayerStats(playerId, allianceId),
    enabled: !!playerId && !!allianceId,
  });
}

export function usePlayerInfo(playerId) {
  return useQuery({
    queryKey: ['at', 'player', playerId],
    queryFn: () => fetchAlliancePlayer(playerId),
    enabled: !!playerId,
  });
}
