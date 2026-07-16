import { useQuery } from '@tanstack/react-query';
import { fetchParticipationRate, fetchParticipationRates } from '../queries/atQueries';

export function useParticipationRates(allianceId) {
  return useQuery({
    queryKey: ['at', 'participation-rates', allianceId],
    queryFn: () => fetchParticipationRates(allianceId),
    enabled: !!allianceId,
  });
}

export function useParticipationRate(allianceId, playerId) {
  return useQuery({
    queryKey: ['at', 'participation-rate', allianceId, playerId],
    queryFn: () => fetchParticipationRate(allianceId, playerId),
    enabled: !!allianceId && !!playerId,
  });
}
