import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

// Returns: undefined while loading, null when not authenticated, Session object when authenticated
export function useAuth() {
  const [session, setSession] = useState(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });
    return () => subscription.unsubscribe();
  }, []);

  return session;
}
