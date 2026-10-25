/** OMP can evict old tool images; keep those bytes outside the cached transcript. */
export const TOOL_RESULT_IMAGE_TAIL_HEADER = 'x-kin-tool-result-images'

const OMP_IMAGE_OMISSION = '[image omitted: provider image limit]'

export function toolResultImageTailRequested(headers = {}) {
  return (
    String(headers[TOOL_RESULT_IMAGE_TAIL_HEADER] || '')
      .trim()
      .toLowerCase() === 'tail'
  )
}

/** Keep tool pairing and text in place; attribute extracted images after the cache boundary. */
export function moveToolResultImagesToTail(body) {
  if (!Array.isArray(body?.messages)) return body
  const signedHistory = body.messages.some(
    (message) =>
      message?.role === 'assistant' &&
      Array.isArray(message.content) &&
      message.content.some((block) => block?.type === 'thinking' || block?.type === 'redacted_thinking'),
  )
  if (signedHistory && body.thinking?.block_binding?.prefix_mismatch_behavior !== 'drop_block') {
    const error = new Error(
      'Tool-result image tail mode changes signed thinking prefixes. ' +
        'Explicitly set thinking.block_binding.prefix_mismatch_behavior to drop_block, or disable tail mode.',
    )
    error.status = 400
    error.body = {
      type: 'error',
      error: { type: 'invalid_request_error', code: 'tool_result_image_tail_binding', message: error.message },
    }
    throw error
  }
  const images = []
  let changed = false
  const messages = body.messages.map((message) => {
    if (message?.role !== 'user' || !Array.isArray(message.content)) return message
    let touched = false
    const content = message.content.map((block) => {
      if (block?.type !== 'tool_result' || !Array.isArray(block.content)) return block
      const retained = []
      const attachments = []
      for (const part of block.content) {
        if (part?.type === 'image') {
          const { cache_control: _cache, ...image } = part
          attachments.push(image)
        } else if (part?.type !== 'text' || part.text !== OMP_IMAGE_OMISSION) {
          retained.push(part)
        }
      }
      if (retained.length === block.content.length) return block
      if (attachments.length) {
        images.push(
          { type: 'text', text: `Images from tool result ${JSON.stringify(block.tool_use_id)}:` },
          ...attachments,
        )
      }
      touched = true
      // Image-only results and OMP's later omission text share the same stable prefix.
      return { ...block, content: retained.length ? retained : '' }
    })
    if (!touched) return message
    changed = true
    return { ...message, content }
  })
  if (!changed) return body
  if (images.length) {
    const tail = messages.at(-1)
    if (tail?.role === 'user' && Array.isArray(tail.content)) {
      messages[messages.length - 1] = { ...tail, content: [...tail.content, ...images] }
    } else {
      messages.push({ role: 'user', content: images })
    }
  }
  return { ...body, messages }
}
