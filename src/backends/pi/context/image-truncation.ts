import type { Message } from "@earendil-works/pi-ai";

export interface M3ImageTruncationOptions {
  /** Keep this many most recent historical screenshots. Defaults to 10. */
  screenshotTurns?: number;
  /** Drop old images in whole chunks of this many messages. Defaults to 20. */
  chunkSize?: number;
  /** Text that replaces a dropped screenshot. Defaults to "Tool result: Success". */
  placeholder?: string;
}

interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

/**
 * M3-style deterministic image truncation.
 *
 * Unlike pi-summary / turn-retention, this never calls the model: every
 * request view mirrors the official M3 trajectory window: the first
 * screenshot is always retained, the most recent K historical screenshots
 * are retained, and older screenshots are dropped in whole chunks of T and
 * replaced with a fixed text placeholder.
 */
export function applyM3ImageTruncation(
  messages: Message[],
  options: M3ImageTruncationOptions = {},
): Message[] {
  const screenshotTurns = options.screenshotTurns ?? 10;
  const chunkSize = Math.max(1, options.chunkSize ?? 20);
  const placeholder = options.placeholder ?? "Tool result: Success";

  const imageMessageIndexes = messages.flatMap((message, index) =>
    hasImageBlock(message.content) ? [index] : [],
  );
  // M3 keeps the initial screenshot as a permanent anchor; only the images
  // after it participate in the K/T truncation window.
  const historicalImageIndexes = imageMessageIndexes.slice(1);
  const remove = Math.max(0, historicalImageIndexes.length - screenshotTurns);
  const dropCount = remove - (remove % chunkSize);
  if (dropCount <= 0) return messages;

  const droppedIndexes = new Set(historicalImageIndexes.slice(0, dropCount));
  return messages.map((message, index) =>
    droppedIndexes.has(index) ? replaceImageMessage(message, placeholder) : message,
  );
}

function hasImageBlock(content: Message["content"]): boolean {
  return (
    Array.isArray(content) &&
    content.some((block) => (block as unknown as ContentBlock).type === "image")
  );
}

function replaceImageBlocks(message: Message, placeholder: string): Message {
  const content = message.content;
  if (!Array.isArray(content)) return message;
  const replaced = content.map((block) =>
    (block as unknown as ContentBlock).type === "image"
      ? { type: "text", text: placeholder }
      : block,
  );
  return { ...message, content: replaced } as Message;
}

function replaceImageMessage(message: Message, placeholder: string): Message {
  // Official M3 replaces a dropped screenshot user turn with a text-only
  // placeholder; toolResult image blocks keep their surrounding text so tool
  // diagnostics are not lost.
  if (message.role === "user" && Array.isArray(message.content)) {
    return { ...message, content: [{ type: "text", text: placeholder }] } as Message;
  }
  return replaceImageBlocks(message, placeholder);
}
