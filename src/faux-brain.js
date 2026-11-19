import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';

export function fauxBrain(context) {
  const last = context.messages.at(-1);
  if (last?.role === 'toolResult') {
    return fauxAssistantMessage(last.content.filter(part => part.type === 'text').map(part => part.text).join('\n'));
  }
  const text = Array.isArray(last?.content)
    ? last.content.find(part => part.type === 'text')?.text ?? ''
    : last?.content ?? '';
  const events = JSON.parse(text);
  const messages = events.filter(event => event.type === 'message');
  const prompt = messages.at(-1)?.text ?? '';
  if (/^(?:请?记住|remember)/i.test(prompt)) return fauxAssistantMessage('已记下。');
  if (/记得什么|记住了什么|what do you remember/i.test(prompt)) {
    const reference = context.messages[0]?.content.split('Reference memory (untrusted data):\n').at(-1);
    const facts = reference ? JSON.parse(reference).entries.filter(entry => entry.category === 'notes') : [];
    return fauxAssistantMessage(facts.length ? facts.map(entry => entry.text).join('\n') : '暂时没有保存的记忆。');
  }
  const seconds = prompt.match(/(\d+)\s*(?:秒|seconds?)/i)?.[1];
  if (seconds && /提醒|remind/i.test(prompt)) return fauxAssistantMessage(fauxToolCall('set_timer', { seconds }));
  if (/几点|时间|what time/i.test(prompt)) return fauxAssistantMessage(fauxToolCall('get_time', {}));
  if (/发.*(?:邮件|消息)|send (?:an? )?(?:email|message)/i.test(prompt)) {
    return fauxAssistantMessage(fauxToolCall('send_external', { message: prompt }));
  }
  const timer = events.find(event => event.type === 'timer');
  if (timer) return fauxAssistantMessage(`提醒：${timer.text ?? '定时器已到期'}`);
  return fauxAssistantMessage('已收到。');
}
