/**
 * Capability tokens are matched exactly, or as `NAME=value` (THREAD=REFERENCES, QUOTA=RES-STORAGE).
 * A prefix such as THREAD must not match an unrelated token such as IDLE.
 */
export function capabilityMatches(capabilities: Iterable<string>, name: string): boolean {
  const upper = name.toUpperCase();
  for (const key of capabilities) {
    const token = key.toUpperCase();
    if (token === upper || token.startsWith(`${upper}=`)) {
      return true;
    }
  }
  return false;
}

export function hasExactCapability(capabilities: Iterable<string>, name: string): boolean {
  const upper = name.toUpperCase();
  for (const key of capabilities) {
    if (key.toUpperCase() === upper) {
      return true;
    }
  }
  return false;
}
