type Labels = Record<string, string | number | boolean | undefined>;

const counters = new Map<string, number>();
const keyFor = (name: string, labels: Labels) =>
  `${name}|${Object.entries(labels)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(",")}`;

export function incrementMetric(name: string, labels: Labels = {}, value = 1) {
  const key = keyFor(name, labels);
  counters.set(key, (counters.get(key) ?? 0) + value);
}

export function metricSnapshot(organizationId?: string) {
  return [...counters.entries()]
    .filter(([key]) =>
      organizationId
        ? !key.includes("organizationId=") ||
          key.includes(`organizationId=${organizationId}`)
        : true,
    )
    .map(([key, value]) => {
      const [name, labels = ""] = key.split("|", 2);
      return { name, labels, value };
    });
}

export function resetMetricsForTest() {
  counters.clear();
}
