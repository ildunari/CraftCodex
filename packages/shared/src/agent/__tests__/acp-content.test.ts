import { describe, expect, it } from 'bun:test';

import {
  buildPromptContent,
  extractAcpText,
  walkContentBlocks,
} from '../acp/acp-content.ts';
import type { FileAttachment } from '../../utils/files.ts';

const txtAttachment = (over: Partial<FileAttachment> = {}): FileAttachment => ({
  type: 'text',
  path: '/tmp/notes.md',
  name: 'notes.md',
  mimeType: 'text/markdown',
  size: 12,
  storedPath: '/sess/notes.md',
  ...over,
});

const imgAttachment = (over: Partial<FileAttachment> = {}): FileAttachment => ({
  type: 'image',
  path: '/tmp/pic.png',
  name: 'pic.png',
  mimeType: 'image/png',
  size: 1024,
  base64: 'AAAA',
  ...over,
});

describe('buildPromptContent', () => {
  it('emits a single text block for a plain message', () => {
    expect(buildPromptContent('hello', undefined, undefined)).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('emits an empty text block when message and attachments are empty', () => {
    expect(buildPromptContent('', undefined, undefined)).toEqual([{ type: 'text', text: '' }]);
  });

  it('renders text attachments as a [Attached file: ...] reference', () => {
    const blocks = buildPromptContent('hi', [txtAttachment()], { image: true });
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'text', text: 'hi' });
    expect(blocks[1]?.type).toBe('text');
    expect(blocks[1] as { text: string }).toMatchObject({
      text: '[Attached file: notes.md]\n[Stored at: /sess/notes.md]',
    });
  });

  it('inlines image attachments when promptCapabilities.image is true', () => {
    const blocks = buildPromptContent('look', [imgAttachment()], { image: true });
    expect(blocks).toContainEqual({
      type: 'image',
      data: 'AAAA',
      mimeType: 'image/png',
      uri: '/tmp/pic.png',
    });
  });

  it('falls back to text reference for image attachments when image cap is off', () => {
    const blocks = buildPromptContent('look', [imgAttachment()], { image: false });
    expect(blocks.find(b => b.type === 'image')).toBeUndefined();
    expect(blocks.some(b => b.type === 'text' && (b as { text: string }).text.startsWith('[Attached file:'))).toBe(true);
  });
});

describe('walkContentBlocks', () => {
  it('extracts text from a content array on agent_message_chunk', () => {
    const out = walkContentBlocks(
      { content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] },
      'agent_message_chunk',
    );
    expect(out.texts).toEqual(['hello ', 'world']);
    expect(out.thoughts).toEqual([]);
  });

  it('extracts text from a single content object', () => {
    const out = walkContentBlocks(
      { content: { type: 'text', text: 'hi' } },
      'agent_message_chunk',
    );
    expect(out.texts).toEqual(['hi']);
  });

  it('routes agent_thought_chunk content into thoughts', () => {
    const out = walkContentBlocks(
      { content: [{ type: 'text', text: 'thinking...' }] },
      'agent_thought_chunk',
    );
    expect(out.thoughts).toEqual(['thinking...']);
    expect(out.texts).toEqual([]);
  });

  it('also picks up bare `text` field as a fallback', () => {
    const out = walkContentBlocks({ text: 'inline' }, 'agent_message_chunk');
    expect(out.texts).toEqual(['inline']);
  });

  it('returns empty buckets for non-text content blocks', () => {
    const out = walkContentBlocks(
      { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] },
      'agent_message_chunk',
    );
    expect(out.texts).toEqual([]);
  });
});

describe('extractAcpText', () => {
  it('extracts common ACP text payload shapes from a result blob', () => {
    expect(extractAcpText({
      delta: { text: 'hello' },
      content: [{ text: ' world' }],
      ignored: 'nope',
    })).toEqual(['hello', ' world']);
  });
});
