const RETIRED_ACADEMY_STORAGE_PREFIX = "hms-academy-";

type RemovableStorage = Pick<Storage, "key" | "length" | "removeItem">;

/** Remove retired Academy data without touching Solo history or user preferences. */
export function purgeRetiredAcademyProgress(
  storage: RemovableStorage = window.localStorage,
): readonly string[] {
  const academyKeys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(RETIRED_ACADEMY_STORAGE_PREFIX)) academyKeys.push(key);
    }
  } catch {
    return [];
  }

  const removed: string[] = [];
  for (const key of academyKeys) {
    try {
      storage.removeItem(key);
      removed.push(key);
    } catch {
      // Storage may be blocked; removal is retried on the next app load.
    }
  }
  return removed;
}
