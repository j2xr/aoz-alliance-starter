/**
 * Exécute `fn` sur chaque élément avec au plus `limit` exécutions simultanées.
 *
 * Les résultats sont retournés dans l'ordre d'entrée (indépendamment de
 * l'ordre d'achèvement). Un rejet de `fn` interrompt l'ensemble, comme
 * Promise.all — les erreurs attendues doivent donc être gérées DANS `fn`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}
