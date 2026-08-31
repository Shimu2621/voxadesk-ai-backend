export function maskPhone(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 4 ? `•••-•••-${digits.slice(-4)}` : "••••";
}

export function maskEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  const [local, domain] = value.split("@");
  if (!local || !domain) return "••••";
  return `${local.slice(0, 1)}•••@${domain}`;
}

export function maskTranscript(value: string): string {
  return value.length ? "[Transcript hidden by viewer policy]" : value;
}
