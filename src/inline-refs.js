// Inline attachments in item and comment bodies (mission: inline images).
// A body places one of its own attachments in the text as
// `![caption](attachment:<blob_ref>)`; apps that know the form split the body
// there (text, image, text …) and append the attachments no ref uses. The
// grammar and the code-span rule are shared with every client — change them
// together.
export const INLINE_REF_RE = /!\[([^\]\n]*)\]\(attachment:([A-Za-z0-9_-]{1,128})\)/g

// Apps that render the refs send `X-Matron-Item-Inline: attachments`; to the
// rest the journal presents each ref as its caption, so an old app shows
// clean text with the images at the end as before. Agents always see the
// stored text.
export const ITEM_INLINE_HEADER = 'x-matron-item-inline'
export function knowsInlineRefs(req, who) {
  if (who.kind === 'agent') return true
  const h = req.headers?.[ITEM_INLINE_HEADER]
  return typeof h === 'string' && h.split(',').some((k) => k.trim().toLowerCase() === 'attachments')
}

// Calls fn(text, isCode) over `s` in order: fenced blocks (``` or ~~~ lines up
// to the closing fence) are code; everything else is prose.
function eachBlock(s, fn) {
  const lines = s.split('\n')
  let fence = null
  let prose = ''
  lines.forEach((line, i) => {
    const full = i < lines.length - 1 ? `${line}\n` : line
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      fn(full, true)
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null
    } else if (marker) {
      if (prose) { fn(prose, false); prose = '' }
      fence = marker[1]
      fn(full, true)
    } else {
      prose += full
    }
  })
  if (prose) fn(prose, false)
}

// The ref matches in a prose block that no inline code span hides. A span
// hides a ref when it covers the ref's start, or opens inside the ref and runs
// past its end; a span wholly inside the caption (`![run `make`](…)`) does not.
function proseRefs(text) {
  const spans = [...text.matchAll(/(`+)[^`]*?\1/g)].map((m) => [m.index, m.index + m[0].length])
  return [...text.matchAll(INLINE_REF_RE)].filter((m) => {
    const a = m.index
    const b = a + m[0].length
    return !spans.some(([s, e]) => (s < a && a < e) || (s >= a && s < b && e > b))
  })
}

// The blob refs a body places, in order, outside code.
export function inlineRefs(s) {
  const out = []
  if (typeof s !== 'string' || !s.includes('attachment:')) return out
  eachBlock(s, (text, code) => {
    if (!code) for (const m of proseRefs(text)) out.push(m[2])
  })
  return out
}

// `s` with every ref outside code replaced by its caption (or `(image)`).
export function inlineRefsToText(s) {
  if (typeof s !== 'string' || !s.includes('attachment:')) return s
  let out = ''
  eachBlock(s, (text, code) => {
    if (code) { out += text; return }
    let last = 0
    for (const m of proseRefs(text)) {
      out += text.slice(last, m.index) + (m[1].trim() || '(image)')
      last = m.index + m[0].length
    }
    out += text.slice(last)
  })
  return out
}

// Answers the first ref that names none of `attachments`, or null.
export function strayInlineRef(body, attachments) {
  const refs = inlineRefs(body)
  if (!refs.length) return null
  const have = new Set((attachments || []).map((a) => a?.blob_ref))
  return refs.find((r) => !have.has(r)) ?? null
}
