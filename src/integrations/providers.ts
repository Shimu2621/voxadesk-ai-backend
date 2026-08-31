export type ProviderResult<T> =
  | { success: true; data: T }
  | {
      success: false;
      code: "NOT_CONFIGURED" | "TIMEOUT" | "REJECTED" | "CONFLICT";
      message: string;
    };

const providerFailure = (error: unknown): ProviderResult<never> => ({
  success: false,
  code:
    error instanceof DOMException && error.name === "AbortError"
      ? "TIMEOUT"
      : "REJECTED",
  message: error instanceof Error ? error.message : "Provider request failed.",
});

async function providerFetch(
  url: string,
  init: RequestInit,
  timeoutMs = 10_000,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(
        `Provider returned ${response.status}${detail ? `: ${detail}` : "."}`,
      );
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

export interface VoiceProvider {
  createSignedSession(input: {
    agentId: string;
    organizationId: string;
  }): Promise<ProviderResult<{ token: string; expiresAt: Date }>>;
  publishAgent(input: {
    agentId: string;
    version: number;
    config: Record<string, unknown>;
  }): Promise<ProviderResult<{ providerAgentId: string }>>;
}

export interface TelephonyProvider {
  routeInbound(input: {
    phoneNumber: string;
    providerCallId: string;
  }): Promise<ProviderResult<{ providerConversationId: string }>>;
  transfer(input: {
    providerCallId: string;
    destination: string;
    idempotencyKey: string;
  }): Promise<ProviderResult<{ transferId: string }>>;
}

export type CalendarSlot = { startAt: Date; endAt: Date; timezone: string };
export interface CalendarProvider {
  availability(input: {
    calendarId: string;
    from: Date;
    to: Date;
    durationMinutes: number;
    timezone: string;
  }): Promise<ProviderResult<CalendarSlot[]>>;
  createEvent(input: {
    calendarId: string;
    slot: CalendarSlot;
    title: string;
    idempotencyKey: string;
  }): Promise<ProviderResult<{ eventId: string }>>;
  updateEvent(input: {
    calendarId: string;
    eventId: string;
    slot: CalendarSlot;
    idempotencyKey: string;
  }): Promise<ProviderResult<{ eventId: string }>>;
  cancelEvent(input: {
    calendarId: string;
    eventId: string;
    idempotencyKey: string;
  }): Promise<ProviderResult<{ eventId: string }>>;
}

export interface BillingProvider {
  createCheckout(input: {
    organizationId: string;
    planCode: string;
    returnUrl: string;
  }): Promise<ProviderResult<{ url: string }>>;
  createPortal(input: {
    customerId: string;
    returnUrl: string;
  }): Promise<ProviderResult<{ url: string }>>;
}

export interface StorageProvider {
  put(input: {
    organizationId: string;
    key: string;
    contentType: string;
    bytes: Uint8Array;
  }): Promise<ProviderResult<{ storageKey: string; checksum: string }>>;
  get(input: {
    organizationId: string;
    storageKey: string;
  }): Promise<ProviderResult<{ contentType: string; bytes: Uint8Array }>>;
}

export type MockMode = "success" | "timeout" | "rejected";
const failure = (
  mode: Exclude<MockMode, "success">,
): ProviderResult<never> => ({
  success: false,
  code: mode === "timeout" ? "TIMEOUT" : "REJECTED",
  message: `Mock provider ${mode}.`,
});

export class MockVoiceProvider implements VoiceProvider {
  constructor(private readonly mode: MockMode = "success") {}
  async createSignedSession(input: {
    agentId: string;
    organizationId: string;
  }): Promise<ProviderResult<{ token: string; expiresAt: Date }>> {
    if (this.mode !== "success") return failure(this.mode);
    return {
      success: true,
      data: {
        token: `mock-session-${input.organizationId}-${input.agentId}`,
        expiresAt: new Date(Date.now() + 5 * 60_000),
      },
    };
  }
  async publishAgent(input: {
    agentId: string;
    version: number;
    config: Record<string, unknown>;
  }): Promise<ProviderResult<{ providerAgentId: string }>> {
    if (this.mode !== "success") return failure(this.mode);
    return {
      success: true,
      data: {
        providerAgentId: `mock-agent-${input.agentId}-v${input.version}`,
      },
    };
  }
}

export class MockTelephonyProvider implements TelephonyProvider {
  private readonly transfers = new Map<string, string>();
  constructor(private readonly mode: MockMode = "success") {}
  async routeInbound(input: {
    phoneNumber: string;
    providerCallId: string;
  }): Promise<ProviderResult<{ providerConversationId: string }>> {
    if (this.mode !== "success") return failure(this.mode);
    return {
      success: true,
      data: {
        providerConversationId: `mock-conversation-${input.providerCallId}`,
      },
    };
  }
  async transfer(input: {
    providerCallId: string;
    destination: string;
    idempotencyKey: string;
  }): Promise<ProviderResult<{ transferId: string }>> {
    if (this.mode !== "success") return failure(this.mode);
    const transferId =
      this.transfers.get(input.idempotencyKey) ??
      `mock-transfer-${this.transfers.size + 1}`;
    this.transfers.set(input.idempotencyKey, transferId);
    return { success: true, data: { transferId } };
  }
}

export class MockCalendarProvider implements CalendarProvider {
  private readonly actions = new Map<string, string>();
  constructor(
    private readonly mode: MockMode = "success",
    private readonly slots: CalendarSlot[] = [],
  ) {}
  async availability(input: {
    calendarId: string;
    from: Date;
    to: Date;
    durationMinutes: number;
    timezone: string;
  }): Promise<ProviderResult<CalendarSlot[]>> {
    if (this.mode !== "success") return failure(this.mode);
    const endAt = new Date(
      input.from.getTime() + input.durationMinutes * 60_000,
    );
    return {
      success: true,
      data: this.slots.length
        ? this.slots
        : endAt <= input.to
          ? [{ startAt: input.from, endAt, timezone: input.timezone }]
          : [],
    };
  }
  async createEvent(input: {
    calendarId: string;
    slot: CalendarSlot;
    title: string;
    idempotencyKey: string;
  }): Promise<ProviderResult<{ eventId: string }>> {
    return this.action(input.idempotencyKey);
  }
  async updateEvent(input: {
    calendarId: string;
    eventId: string;
    slot: CalendarSlot;
    idempotencyKey: string;
  }): Promise<ProviderResult<{ eventId: string }>> {
    return this.action(input.idempotencyKey);
  }
  async cancelEvent(input: {
    calendarId: string;
    eventId: string;
    idempotencyKey: string;
  }): Promise<ProviderResult<{ eventId: string }>> {
    return this.action(input.idempotencyKey);
  }
  private async action(
    idempotencyKey: string,
  ): Promise<ProviderResult<{ eventId: string }>> {
    if (this.mode !== "success") return failure(this.mode);
    const eventId =
      this.actions.get(idempotencyKey) ?? `mock-event-${this.actions.size + 1}`;
    this.actions.set(idempotencyKey, eventId);
    return { success: true, data: { eventId } };
  }
}

export class MockBillingProvider implements BillingProvider {
  constructor(private readonly mode: MockMode = "success") {}
  async createCheckout(input: {
    organizationId: string;
    planCode: string;
    returnUrl: string;
  }): Promise<ProviderResult<{ url: string }>> {
    if (this.mode !== "success") return failure(this.mode);
    return {
      success: true,
      data: {
        url: `https://mock.stripe.local/checkout/${input.organizationId}/${input.planCode}`,
      },
    };
  }
  async createPortal(input: {
    customerId: string;
    returnUrl: string;
  }): Promise<ProviderResult<{ url: string }>> {
    if (this.mode !== "success") return failure(this.mode);
    return {
      success: true,
      data: { url: `https://mock.stripe.local/portal/${input.customerId}` },
    };
  }
}

export class MockStorageProvider implements StorageProvider {
  private readonly objects = new Map<
    string,
    { contentType: string; bytes: Uint8Array }
  >();
  async put(input: {
    organizationId: string;
    key: string;
    contentType: string;
    bytes: Uint8Array;
  }): Promise<ProviderResult<{ storageKey: string; checksum: string }>> {
    const storageKey = `${input.organizationId}/${input.key}`;
    this.objects.set(storageKey, {
      contentType: input.contentType,
      bytes: input.bytes,
    });
    const checksum = Array.from(input.bytes)
      .reduce((value, byte) => (value + byte) % 1_000_000_007, 0)
      .toString(16);
    return { success: true, data: { storageKey, checksum } };
  }
  async get(input: {
    organizationId: string;
    storageKey: string;
  }): Promise<ProviderResult<{ contentType: string; bytes: Uint8Array }>> {
    if (!input.storageKey.startsWith(`${input.organizationId}/`))
      return {
        success: false,
        code: "REJECTED",
        message: "Storage object is outside the active organization.",
      };
    const object = this.objects.get(input.storageKey);
    return object
      ? { success: true, data: object }
      : {
          success: false,
          code: "REJECTED",
          message: "Storage object not found.",
        };
  }
}

export class ElevenLabsVoiceProvider implements VoiceProvider {
  constructor(private readonly apiKey: string) {}

  async createSignedSession(input: {
    agentId: string;
    organizationId: string;
  }): Promise<ProviderResult<{ token: string; expiresAt: Date }>> {
    try {
      const response = await providerFetch(
        `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(input.agentId)}`,
        {
          headers: { "xi-api-key": this.apiKey },
        },
      );
      const body = (await response.json()) as { signed_url?: string };
      if (!body.signed_url)
        throw new Error("ElevenLabs did not return a signed URL.");
      return {
        success: true,
        data: {
          token: body.signed_url,
          expiresAt: new Date(Date.now() + 10 * 60_000),
        },
      };
    } catch (error) {
      return providerFailure(error);
    }
  }

  async publishAgent(input: {
    agentId: string;
    version: number;
    config: Record<string, unknown>;
  }): Promise<ProviderResult<{ providerAgentId: string }>> {
    try {
      const response = await providerFetch(
        "https://api.elevenlabs.io/v1/convai/agents/create",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "xi-api-key": this.apiKey,
          },
          body: JSON.stringify({
            name: `${String(input.config.name ?? input.agentId)} v${input.version}`,
            conversation_config: input.config,
          }),
        },
      );
      const body = (await response.json()) as { agent_id?: string };
      if (!body.agent_id)
        throw new Error("ElevenLabs did not return an agent ID.");
      return { success: true, data: { providerAgentId: body.agent_id } };
    } catch (error) {
      return providerFailure(error);
    }
  }
}

export class TwilioTelephonyProvider implements TelephonyProvider {
  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
  ) {}
  private get authorization() {
    return `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64")}`;
  }

  async routeInbound(input: {
    phoneNumber: string;
    providerCallId: string;
  }): Promise<ProviderResult<{ providerConversationId: string }>> {
    return {
      success: true,
      data: { providerConversationId: input.providerCallId },
    };
  }

  async transfer(input: {
    providerCallId: string;
    destination: string;
    idempotencyKey: string;
  }): Promise<ProviderResult<{ transferId: string }>> {
    try {
      const form = new URLSearchParams({
        Twiml: `<Response><Dial>${input.destination}</Dial></Response>`,
      });
      const response = await providerFetch(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}/Calls/${encodeURIComponent(input.providerCallId)}.json`,
        {
          method: "POST",
          headers: {
            authorization: this.authorization,
            "content-type": "application/x-www-form-urlencoded",
            "Idempotency-Key": input.idempotencyKey,
          },
          body: form,
        },
      );
      const body = (await response.json()) as { sid?: string };
      return body.sid
        ? { success: true, data: { transferId: body.sid } }
        : {
            success: false,
            code: "REJECTED",
            message: "Twilio did not return a call ID.",
          };
    } catch (error) {
      return providerFailure(error);
    }
  }
}

type GoogleCredentials = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};
export class GoogleCalendarProvider implements CalendarProvider {
  private token?: { value: string; expiresAt: number };
  constructor(private readonly credentials: GoogleCredentials) {}
  private async accessToken() {
    if (this.token && this.token.expiresAt > Date.now() + 30_000)
      return this.token.value;
    const response = await providerFetch(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.credentials.clientId,
          client_secret: this.credentials.clientSecret,
          refresh_token: this.credentials.refreshToken,
          grant_type: "refresh_token",
        }),
      },
    );
    const body = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!body.access_token)
      throw new Error("Google did not return an access token.");
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    };
    return body.access_token;
  }
  private async request(url: string, init: RequestInit = {}) {
    return providerFetch(url, {
      ...init,
      headers: {
        ...init.headers,
        authorization: `Bearer ${await this.accessToken()}`,
        "content-type": "application/json",
      },
    });
  }
  async availability(input: {
    calendarId: string;
    from: Date;
    to: Date;
    durationMinutes: number;
    timezone: string;
  }): Promise<ProviderResult<CalendarSlot[]>> {
    try {
      const response = await this.request(
        "https://www.googleapis.com/calendar/v3/freeBusy",
        {
          method: "POST",
          body: JSON.stringify({
            timeMin: input.from.toISOString(),
            timeMax: input.to.toISOString(),
            timeZone: input.timezone,
            items: [{ id: input.calendarId }],
          }),
        },
      );
      const body = (await response.json()) as {
        calendars?: Record<
          string,
          { busy?: Array<{ start: string; end: string }> }
        >;
      };
      const busy = body.calendars?.[input.calendarId]?.busy ?? [];
      const slots: CalendarSlot[] = [];
      const duration = input.durationMinutes * 60_000;
      for (
        let start = input.from.getTime();
        start + duration <= input.to.getTime() && slots.length < 20;
        start += duration
      ) {
        const end = start + duration;
        if (
          !busy.some(
            (period) =>
              new Date(period.start).getTime() < end &&
              new Date(period.end).getTime() > start,
          )
        )
          slots.push({
            startAt: new Date(start),
            endAt: new Date(end),
            timezone: input.timezone,
          });
      }
      return { success: true, data: slots };
    } catch (error) {
      return providerFailure(error);
    }
  }
  async createEvent(input: {
    calendarId: string;
    slot: CalendarSlot;
    title: string;
    idempotencyKey: string;
  }): Promise<ProviderResult<{ eventId: string }>> {
    return this.writeEvent(
      input.calendarId,
      undefined,
      input.slot,
      input.title,
      input.idempotencyKey,
    );
  }
  async updateEvent(input: {
    calendarId: string;
    eventId: string;
    slot: CalendarSlot;
    idempotencyKey: string;
  }): Promise<ProviderResult<{ eventId: string }>> {
    return this.writeEvent(
      input.calendarId,
      input.eventId,
      input.slot,
      undefined,
      input.idempotencyKey,
    );
  }
  private async writeEvent(
    calendarId: string,
    eventId: string | undefined,
    slot: CalendarSlot,
    title: string | undefined,
    idempotencyKey: string,
  ): Promise<ProviderResult<{ eventId: string }>> {
    try {
      const suffix = eventId ? `/${encodeURIComponent(eventId)}` : "";
      const response = await this.request(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events${suffix}`,
        {
          method: eventId ? "PATCH" : "POST",
          headers: { "X-Goog-Request-Reason": idempotencyKey },
          body: JSON.stringify({
            ...(title ? { summary: title } : {}),
            start: {
              dateTime: slot.startAt.toISOString(),
              timeZone: slot.timezone,
            },
            end: {
              dateTime: slot.endAt.toISOString(),
              timeZone: slot.timezone,
            },
            extendedProperties: {
              private: { voxadeskIdempotencyKey: idempotencyKey },
            },
          }),
        },
      );
      const body = (await response.json()) as { id?: string };
      if (!body.id) throw new Error("Google did not return an event ID.");
      return { success: true, data: { eventId: body.id } };
    } catch (error) {
      return providerFailure(error);
    }
  }
  async cancelEvent(input: {
    calendarId: string;
    eventId: string;
    idempotencyKey: string;
  }): Promise<ProviderResult<{ eventId: string }>> {
    try {
      await this.request(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.eventId)}`,
        {
          method: "DELETE",
          headers: { "X-Goog-Request-Reason": input.idempotencyKey },
        },
      );
      return { success: true, data: { eventId: input.eventId } };
    } catch (error) {
      return providerFailure(error);
    }
  }
}

export class StripeBillingProvider implements BillingProvider {
  constructor(
    private readonly secretKey: string,
    private readonly priceIds: Record<string, string | undefined>,
  ) {}
  private async post(path: string, values: Record<string, string>) {
    return providerFetch(`https://api.stripe.com/v1/${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(values),
    });
  }
  async createCheckout(input: {
    organizationId: string;
    planCode: string;
    returnUrl: string;
  }): Promise<ProviderResult<{ url: string }>> {
    try {
      const price = this.priceIds[input.planCode];
      if (!price)
        return {
          success: false,
          code: "NOT_CONFIGURED",
          message: `Stripe price is not configured for ${input.planCode}.`,
        };
      const response = await this.post("checkout/sessions", {
        mode: "subscription",
        "line_items[0][price]": price,
        "line_items[0][quantity]": "1",
        success_url: input.returnUrl,
        cancel_url: input.returnUrl,
        client_reference_id: input.organizationId,
        "metadata[organizationId]": input.organizationId,
        "metadata[planCode]": input.planCode,
      });
      const body = (await response.json()) as { url?: string };
      if (!body.url) throw new Error("Stripe did not return a Checkout URL.");
      return { success: true, data: { url: body.url } };
    } catch (error) {
      return providerFailure(error);
    }
  }
  async createPortal(input: {
    customerId: string;
    returnUrl: string;
  }): Promise<ProviderResult<{ url: string }>> {
    try {
      const response = await this.post("billing_portal/sessions", {
        customer: input.customerId,
        return_url: input.returnUrl,
      });
      const body = (await response.json()) as { url?: string };
      if (!body.url) throw new Error("Stripe did not return a portal URL.");
      return { success: true, data: { url: body.url } };
    } catch (error) {
      return providerFailure(error);
    }
  }
}
