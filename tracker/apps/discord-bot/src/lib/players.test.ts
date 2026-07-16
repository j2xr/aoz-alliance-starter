import { describe, expect, it, vi, beforeEach } from 'vitest';
import { resolvePlayerByName } from './players.js';
import { supabase } from './supabase.js';

vi.mock('./supabase.js', () => ({ supabase: { from: vi.fn() } }));

function mkChain(data: unknown, error: string | null = null) {
  const resolved = { data, error };
  const terminal = Promise.resolve(resolved);
  const c: Record<string, unknown> = {
    then: terminal.then.bind(terminal),
    catch: terminal.catch.bind(terminal),
    finally: terminal.finally.bind(terminal),
  };
  for (const m of ['select', 'eq', 'ilike', 'limit']) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  return c;
}

type SupabaseFrom = typeof supabase.from;

function queueChain(data: unknown) {
  const chain = mkChain(data);
  vi.mocked(supabase.from).mockReturnValueOnce(chain as unknown as ReturnType<SupabaseFrom>);
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolvePlayerByName', () => {
  it('returns found for a single match', async () => {
    queueChain([{ id: 'p1', name: 'Alpha' }]);
    const result = await resolvePlayerByName('alliance-1', 'Alpha', { match: 'exact' });
    expect(result).toEqual({ status: 'found', player: { id: 'p1', name: 'Alpha' } });
  });

  it('returns none when nothing matches', async () => {
    queueChain([]);
    const result = await resolvePlayerByName('alliance-1', 'Ghost', { match: 'partial' });
    expect(result).toEqual({ status: 'none' });
  });

  it('returns ambiguous with candidates on multiple matches', async () => {
    queueChain([
      { id: 'p1', name: 'Alpha' },
      { id: 'p2', name: 'Alphabet' },
    ]);
    const result = await resolvePlayerByName('alliance-1', 'Alpha', { match: 'partial' });
    expect(result.status).toBe('ambiguous');
    if (result.status === 'ambiguous') {
      expect(result.candidates.map((p) => p.name)).toEqual(['Alpha', 'Alphabet']);
    }
  });

  it('escapes LIKE metacharacters and applies the match mode', async () => {
    const exactChain = queueChain([{ id: 'p1', name: 'a_b' }]);
    await resolvePlayerByName('alliance-1', 'a_b', { match: 'exact' });
    expect((exactChain['ilike'] as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
      'name',
      'a\\_b',
    ]);
    expect((exactChain['limit'] as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([2]);

    const partialChain = queueChain([]);
    await resolvePlayerByName('alliance-1', '50%', { match: 'partial' });
    expect((partialChain['ilike'] as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
      'name',
      '%50\\%%',
    ]);
    expect((partialChain['limit'] as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([5]);
  });
});
