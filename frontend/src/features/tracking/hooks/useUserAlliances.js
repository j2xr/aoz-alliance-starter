import { useQuery } from '@tanstack/react-query';
import { fetchUserAlliances } from '../queries/atQueries';

export function useUserAlliances() {
  return useQuery({
    queryKey: ['at', 'my-alliances'],
    queryFn: fetchUserAlliances,
    staleTime: 1000 * 60 * 10,
  });
}
