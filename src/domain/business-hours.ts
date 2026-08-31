import { z } from "zod";

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
export const intervalSchema = z
  .object({
    open: z.string().regex(timePattern),
    close: z.string().regex(timePattern),
  })
  .refine((value) => value.open < value.close, {
    message: "Closing time must be after opening time.",
  });
export const weeklyHoursSchema = z.object({
  monday: z.array(intervalSchema).default([]),
  tuesday: z.array(intervalSchema).default([]),
  wednesday: z.array(intervalSchema).default([]),
  thursday: z.array(intervalSchema).default([]),
  friday: z.array(intervalSchema).default([]),
  saturday: z.array(intervalSchema).default([]),
  sunday: z.array(intervalSchema).default([]),
});
export const closureSchema = z.object({
  date: z.string().date(),
  label: z.string().max(100).optional(),
});
export type WeeklyHours = z.infer<typeof weeklyHoursSchema>;
export type Closure = z.infer<typeof closureSchema>;

const weekdayMap: Record<string, keyof WeeklyHours> = {
  Mon: "monday",
  Tue: "tuesday",
  Wed: "wednesday",
  Thu: "thursday",
  Fri: "friday",
  Sat: "saturday",
  Sun: "sunday",
};

function localParts(
  date: Date,
  timezone: string,
): { weekday: keyof WeeklyHours | undefined; date: string; time: string } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  const weekdayLabel = parts.weekday;
  return {
    weekday: weekdayLabel ? weekdayMap[weekdayLabel] : undefined,
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

export function businessStatus(input: {
  at: Date;
  timezone: string;
  weeklyHours: WeeklyHours;
  closures?: Closure[];
}): { open: boolean; nextOpening: Date | null } {
  const closures = new Set(
    (input.closures ?? []).map((closure) => closure.date),
  );
  const isOpen = (at: Date) => {
    const local = localParts(at, input.timezone);
    if (!local.weekday || closures.has(local.date)) return false;
    return input.weeklyHours[local.weekday].some(
      (interval) => local.time >= interval.open && local.time < interval.close,
    );
  };
  if (isOpen(input.at)) return { open: true, nextOpening: null };
  const candidate = new Date(input.at);
  candidate.setUTCSeconds(0, 0);
  for (let minute = 1; minute <= 14 * 24 * 60; minute += 1) {
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
    if (isOpen(candidate))
      return { open: false, nextOpening: new Date(candidate) };
  }
  return { open: false, nextOpening: null };
}
