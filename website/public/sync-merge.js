// Apply only local changes relative to the last acknowledged snapshot.
export function mergeSettings(base, local, remote) {
  if (JSON.stringify(base) === JSON.stringify(local)) return remote;
  if (
    base &&
    local &&
    remote &&
    !Array.isArray(local) &&
    typeof local === "object" &&
    typeof base === "object" &&
    typeof remote === "object"
  ) {
    const result = { ...remote };
    for (const key of new Set([...Object.keys(base), ...Object.keys(local)])) {
      if (!(key in local)) {
        if (key in base) delete result[key];
      } else result[key] = mergeSettings(base[key], local[key], remote[key]);
    }
    return result;
  }
  return local;
}
