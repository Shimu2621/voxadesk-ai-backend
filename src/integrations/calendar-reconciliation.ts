import type { RemoteCalendarEvent } from "../domain/calendar-reconciliation.js";
import type { CalendarSlot, ProviderResult } from "./providers.js";

export interface CalendarReconciliationProvider {
  findEvents(
    externalEventId?: string | null,
  ): Promise<ProviderResult<RemoteCalendarEvent[]>>;
  createEvent(input: {
    slot: CalendarSlot;
    idempotencyKey: string;
  }): Promise<ProviderResult<{ eventId: string }>>;
  cancelEvent(input: {
    eventId: string;
    idempotencyKey: string;
  }): Promise<ProviderResult<{ eventId: string }>>;
}

export class FakeCalendarReconciliationProvider implements CalendarReconciliationProvider {
  readonly events = new Map<string, RemoteCalendarEvent>();
  constructor(private readonly fail = false) {}

  async findEvents(
    externalEventId?: string | null,
  ): Promise<ProviderResult<RemoteCalendarEvent[]>> {
    if (this.fail)
      return {
        success: false,
        code: "TIMEOUT",
        message: "Fake calendar timeout.",
      };
    return {
      success: true,
      data: externalEventId
        ? [...this.events.values()].filter(
            (event) => event.eventId === externalEventId,
          )
        : [],
    };
  }

  async createEvent(input: {
    slot: CalendarSlot;
    idempotencyKey: string;
  }): Promise<ProviderResult<{ eventId: string }>> {
    if (this.fail)
      return {
        success: false,
        code: "TIMEOUT",
        message: "Fake calendar timeout.",
      };
    const eventId = `fake-${input.idempotencyKey}`;
    this.events.set(eventId, {
      eventId,
      status: "confirmed",
      startAt: input.slot.startAt,
      endAt: input.slot.endAt,
      updatedAt: new Date(),
    });
    return { success: true, data: { eventId } };
  }

  async cancelEvent(input: {
    eventId: string;
    idempotencyKey: string;
  }): Promise<ProviderResult<{ eventId: string }>> {
    if (this.fail)
      return {
        success: false,
        code: "TIMEOUT",
        message: "Fake calendar timeout.",
      };
    const existing = this.events.get(input.eventId);
    if (existing)
      this.events.set(input.eventId, {
        ...existing,
        status: "cancelled",
        updatedAt: new Date(),
      });
    return { success: true, data: { eventId: input.eventId } };
  }
}
