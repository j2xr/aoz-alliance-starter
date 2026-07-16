import { useQuery } from '@tanstack/react-query';
import { fetchEventLeaderboard } from '../queries/atQueries';

export function useEventLeaderboard(eventId) {
  return useQuery({
    queryKey: ['at', 'leaderboard', eventId],
    queryFn: () => fetchEventLeaderboard(eventId),
    enabled: !!eventId,
  });
}
