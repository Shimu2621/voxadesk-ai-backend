export function isTransferAllowed(
  destination: string,
  allowlist: readonly string[],
): boolean {
  return (
    /^\+[1-9]\d{7,14}$/.test(destination) && allowlist.includes(destination)
  );
}

export function maskTransferDestination(destination: string): string {
  return `•••${destination.replace(/\D/g, "").slice(-4)}`;
}
