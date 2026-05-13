/**
 * ACP `ContentBlock` builders & decoders.
 *
 * - `buildPromptContent`: assemble the user's `session/prompt` content
 *   array, branching on the agent's advertised `PromptCapabilities`.
 *   Image/audio attachments only become inline blocks when the agent
 *   declared support; otherwise they fall back to a text reference so
 *   the agent can read via its tools.
 *
 * - `walkContentBlocks`: walk a `session/update` payload's content array
 *   per ACP's typed `ContentBlock` schema and bucket each block as text,
 *   thought (for `agent_thought_chunk`), or other (ignored). This replaces
 *   the previous dragnet `extractAcpText` for streaming chunks.
 *
 * - `extractAcpText`: kept as a fallback decoder for `session/prompt`
 *   *result* shapes that don't follow the ContentBlock schema (older agents).
 *   Re-exported so the existing test import keeps working.
 */

import type { FileAttachment } from '../../utils/files.ts';
import type { ContentBlock, PromptCapabilities, TextContentBlock } from './acp-types.ts';

export function textBlock(text: string): TextContentBlock[] {
  return [{ type: 'text', text }];
}

function attachmentToImageBlock(att: FileAttachment): ContentBlock | null {
  if (att.type !== 'image' || !att.base64) return null;
  return { type: 'image', data: att.base64, mimeType: att.mimeType, uri: att.path || undefined };
}

function attachmentToTextRef(att: FileAttachment): TextContentBlock {
  const ref = att.storedPath || att.path || att.name;
  return { type: 'text', text: `[Attached file: ${att.name || ref}]\n[Stored at: ${ref}]` };
}

export function buildPromptContent(
  message: string,
  attachments: readonly FileAttachment[] | undefined,
  caps: PromptCapabilities | undefined,
): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const trimmed = message.trim();
  if (trimmed) blocks.push({ type: 'text', text: message });

  for (const att of attachments ?? []) {
    if (att.type === 'image' && caps?.image) {
      const img = attachmentToImageBlock(att);
      if (img) {
        blocks.push(img);
        continue;
      }
    }
    blocks.push(attachmentToTextRef(att));
  }

  if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
  return blocks;
}

export interface WalkedContent {
  texts: string[];
  thoughts: string[];
}

function pushTextFromContentBlock(block: unknown, sink: string[]): void {
  if (!block || typeof block !== 'object') return;
  const rec = block as Record<string, unknown>;
  if (rec.type === 'text' && typeof rec.text === 'string') {
    sink.push(rec.text);
  }
}

/**
 * Walk a `session/update` payload's content per the ACP `ContentBlock` schema.
 * `kind` indicates which session-update bucket the chunk came from so we can
 * route `agent_thought_chunk` content into `thoughts` instead of `texts`.
 */
export function walkContentBlocks(
  update: Record<string, unknown> | null | undefined,
  kind: 'agent_message_chunk' | 'agent_thought_chunk' | 'user_message_chunk',
): WalkedContent {
  const out: WalkedContent = { texts: [], thoughts: [] };
  if (!update) return out;

  const sink = kind === 'agent_thought_chunk' ? out.thoughts : out.texts;
  const content = update.content;

  if (Array.isArray(content)) {
    for (const block of content) pushTextFromContentBlock(block, sink);
  } else if (content && typeof content === 'object') {
    pushTextFromContentBlock(content, sink);
  }

  // Some agents put a bare `text` on the update (non-spec but seen in the wild).
  if (typeof update.text === 'string') sink.push(update.text);

  return out;
}

/**
 * Permissive text extractor used as a fallback for `session/prompt` *results*
 * whose shape doesn't follow the ContentBlock schema. Walks any nested
 * structure and pulls strings out of common text-bearing keys.
 *
 * Prefer `walkContentBlocks` for streamed `session/update` chunks; this
 * function is the safety net for non-conformant final-response shapes.
 */
export function extractAcpText(value: unknown): string[] {
  const texts: string[] = [];
  const seen = new Set<unknown>();

  const visit = (node: unknown, keyHint?: string): void => {
    if (node == null) return;
    if (typeof node === 'string') {
      if (keyHint && /^(text|delta|content|message|output)$/i.test(keyHint)) {
        texts.push(node);
      }
      return;
    }
    if (typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) visit(item, keyHint);
      return;
    }

    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      visit(child, key);
    }
  };

  visit(value);
  return texts.filter(text => text.trim().length > 0);
}
