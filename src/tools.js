import { randomUUID } from 'node:crypto';
import { obj, opt, str } from '@earendil-works/pi-schema';

const text = value => ({ content: [{ type: 'text', text: value }], details: undefined });

export function createTools(drafts) {
  return [
    {
      name: 'get_time', label: 'Current time', description: 'Get current time in an optional IANA time zone.',
      parameters: obj({ timezone: opt(str()) }), replay: 'safe',
      async execute(_id, { timezone }) {
        return text(new Intl.DateTimeFormat('zh-CN', {
          dateStyle: 'full', timeStyle: 'long', timeZone: timezone ?? 'UTC',
        }).format(new Date()));
      },
    },
    {
      name: 'set_timer', label: 'Set reminder', description: 'Set a follow-up reminder in whole seconds.',
      parameters: obj({ seconds: str() }), replay: 'never',
      async execute(_id, { seconds }) {
        const delay = Number(seconds);
        if (!/^\d+$/.test(seconds) || !Number.isSafeInteger(delay) || delay < 1 || delay > 31536000) {
          throw new Error('Expected a whole number of seconds between 1 and 31536000');
        }
        if (!drafts.has(delay)) drafts.set(delay, { id: randomUUID(), seconds: delay });
        return text(`Reminder scheduled on commit (${delay} seconds).`);
      },
    },
    {
      name: 'send_external', label: 'Simulate sending a message',
      description: 'Request approval to record a simulated external message.',
      parameters: obj({ message: str() }), replay: 'never',
      async execute() {
        throw new Error('External message simulation only runs through the approval executor');
      },
    },
  ];
}
