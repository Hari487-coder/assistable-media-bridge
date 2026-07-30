/**
 * Run `fn` over `items` a few at a time, preserving input order in the result.
 *
 * Used by both bulk onboarding and the waker: each has a list of independent
 * per-tenant jobs where sequential is too slow to finish inside its window and
 * unbounded parallelism would hammer the v3 rate limiter.
 */
export async function mapLimit<T, R>(
  items: T[], limit: number, fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    // `next++` is atomic here: the increment is synchronous, and Node runs one
    // turn at a time, so two workers can never claim the same index.
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]);
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker)
  );
  return out;
}
