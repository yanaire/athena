import { randomInt } from 'node:crypto';
import type { Context, ImageContent } from '@earendil-works/pi-ai';
import { checkDesktopPng, DesktopError } from './desktop-control.ts';
import type { PiModelSelection } from './pi.ts';

export class DesktopImageResult {
  readonly image: ImageContent;
  readonly details: unknown;

  constructor(details: unknown, png: Uint8Array) {
    this.details = details;
    this.image = { type: 'image', mimeType: 'image/png', data: checkDesktopPng(png).toString('base64') };
  }
}

const swatches = {
  red: 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAATElEQVR42u3PQQ0AAAgEoNP+nTWCbzdoQE1+6wgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBZShQF/CY4YrwAAAABJRU5ErkJggg==',
  blue: 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAATUlEQVR42u3PQQ0AAAgEoNP+nTWFDzdoQCWTzzrPCQgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICNxbUIcBf7p/yPgAAAAASUVORK5CYII=',
  green: 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAATUlEQVR42u3PQQ0AAAgEoNPkRreBfzdoQGXyWicCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICArcFYVwBAL949tEAAAAASUVORK5CYII=',
} as const;
const colors = ['red', 'blue', 'green'] as const;

/** The synthetic check uses a tool-result image, the same transport as a real observation. */
export async function verifyDesktopModel(selection: PiModelSelection | undefined, signal: AbortSignal) {
  if (!selection?.model.input.includes('image')) {
    throw new DesktopError('unsupported', 'The selected model connection does not declare image input. FreeCAD window control is unavailable.');
  }
  const { model, modelRuntime } = selection;
  const color = colors[randomInt(colors.length)]!;
  const toolName = 'athena_check_window_image';
  const tools = [{ name: toolName, description: 'Report the color shown in the test image.',
    parameters: { type: 'object', properties: { color: { type: 'string', enum: [...colors] } },
      required: ['color'], additionalProperties: false } }];
  const timestamp = Date.now();
  const prompt = 'Read the attached test image and call athena_check_window_image with its color (red, blue, or green).';
  const call = { type: 'toolCall' as const, id: 'call_athena_window_probe', name: 'athena_test_window', arguments: {} };
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const probe: Context = { tools: [...tools, { name: call.name, description: 'Return the test image.',
    parameters: { type: 'object', properties: {}, additionalProperties: false } }], messages: [
    { role: 'user', content: prompt, timestamp },
    { role: 'assistant', content: [call], api: model.api, provider: model.provider, model: model.id,
      usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } }, stopReason: 'toolUse', timestamp },
    { role: 'toolResult', toolCallId: call.id, toolName: call.name,
      content: [{ type: 'image', mimeType: 'image/png', data: swatches[color] }], isError: false, timestamp },
  ] };
  let reply: Awaited<ReturnType<ReturnType<typeof modelRuntime.streamSimple>['result']>>;
  let status: number | undefined;
  try {
    const result = modelRuntime.streamSimple(model, probe, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
      maxRetries: 0, maxTokens: Math.min(768, model.maxTokens),
      onResponse: response => { status = response.status; },
    });
    reply = await result.result();
  } catch (cause) {
    signal.throwIfAborted();
    throw new DesktopError(status === 401 || status === 403 ? 'denied' : 'failed',
      'The selected model connection could not be checked for image input and tool calls.', { cause });
  }
  signal.throwIfAborted();
  if (reply.stopReason === 'error' || reply.stopReason === 'aborted') {
    throw new DesktopError(status === 401 || status === 403 ? 'denied' : status === 400 || status === 415 ? 'unsupported' : 'failed',
      'The model connection failed during the image and tool call check. No FreeCAD image was sent.');
  }
  if (reply.stopReason !== 'toolUse' || !reply.content.some(part =>
    part.type === 'toolCall' && part.name === toolName && part.arguments.color === color)) {
    throw new DesktopError('unsupported', 'The selected model did not read the test image and return the required tool call.');
  }
}

export function currentDesktopImages<T extends Context>(context: T): T {
  const turn = context.messages.findLastIndex(message => message.role === 'user');
  return { ...context, messages: context.messages.map((message, index) =>
    index < turn && message.role === 'toolResult' && message.toolName === 'freecad_run'
      ? { ...message, content: message.content.filter(part => part.type !== 'image') }
      : message) };
}
