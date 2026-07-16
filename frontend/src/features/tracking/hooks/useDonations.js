import { useQuery } from '@tanstack/react-query';
import {
  fetchDonationPeriods,
  fetchDonationLeaderboard,
  fetchPlayerDonationTotals,
  fetchPlayerDonationHistory,
} from '../queries/atQueries';

export function useDonationPeriods(allianceId) {
  return useQuery({
    queryKey: ['at', 'donation-periods', allianceId],
    queryFn: () => fetchDonationPeriods(allianceId),
    enabled: !!allianceId,
  });
}

export function useDonationLeaderboard(periodId) {
  return useQuery({
    queryKey: ['at', 'donation-leaderboard', periodId],
    queryFn: () => fetchDonationLeaderboard(periodId),
    enabled: !!periodId,
  });
}

export function usePlayerDonationTotals(playerId) {
  return useQuery({
    queryKey: ['at', 'player-donation-totals', playerId],
    queryFn: () => fetchPlayerDonationTotals(playerId),
    enabled: !!playerId,
  });
}

export function usePlayerDonationHistory(playerId, limit = 5) {
  return useQuery({
    queryKey: ['at', 'player-donation-history', playerId, limit],
    queryFn: () => fetchPlayerDonationHistory(playerId, limit),
    enabled: !!playerId,
  });
}
