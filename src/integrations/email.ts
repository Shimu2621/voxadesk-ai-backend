export type EmailMessage = { to: string; subject: string; text: string };

export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}

export class MockEmailProvider implements EmailProvider {
  readonly outbox: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.outbox.push(message);
  }
}

export const emailProvider = new MockEmailProvider();
