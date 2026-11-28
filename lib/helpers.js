const { Range } = require("lumine");

// Small utilities over the messages the hub hands across. Everything here is a
// pure function of one message or one string; anything needing to know what the
// hub knows goes through the handle instead.

/**
 * What a message is about, for display.
 *
 * A message names its subject by path. A buffer that has never been saved has
 * no path, so such a message names the buffer instead and there is nothing to
 * show but that it is untitled.
 * @param {Object} message
 * @returns {string} A label, never null — an unlocated message is not valid.
 */
function messageSubject(message) {
  const file = message.location?.file;
  if (typeof file === "string") {
    return file;
  }
  return "untitled";
}

/**
 * The editor currently showing this buffer, for a message located by buffer
 * rather than by path. Returns null once nothing is showing it, which is the
 * same answer as opening a path that has since been deleted.
 * @param {Object} buffer
 * @returns {Object|null}
 */
function editorForBuffer(buffer) {
  if (!buffer) {
    return null;
  }
  for (const editor of lumine.workspace.getTextEditors()) {
    if (editor.getBuffer() === buffer) {
      return editor;
    }
  }
  return null;
}

// A message excerpt rendered to HTML, keyed by the excerpt itself.
//
// `lumine.tools.markdown.render` builds a MarkdownIt instance, installs its
// plugins, runs the front-matter parser and sanitizes the result on every call
// — far more than a one-line diagnostic is worth, and the panel asks for it once
// per row per render. Keyed by the string rather than by the message because a
// fresh lint run produces new message objects for the same text, and because one
// excerpt is usually reported many times over.
const RENDERED_EXCERPT_LIMIT = 2000;
const renderedExcerpts = new Map();

function renderExcerpt(excerpt) {
  const key = typeof excerpt === "string" ? excerpt : String(excerpt ?? "");
  if (renderedExcerpts.has(key)) {
    // Re-inserted so the entries in use are the last to be evicted.
    const cached = renderedExcerpts.get(key);
    renderedExcerpts.delete(key);
    renderedExcerpts.set(key, cached);
    return cached;
  }
  const html = lumine.tools.markdown.render(key);
  // An excerpt names an identifier or a path often enough that the set of them
  // is not bounded on its own. A Map iterates in insertion order, so the first
  // key is the least recently used one.
  if (renderedExcerpts.size >= RENDERED_EXCERPT_LIMIT) {
    renderedExcerpts.delete(renderedExcerpts.keys().next().value);
  }
  renderedExcerpts.set(key, html);
  return html;
}

function relatedFileTarget({ location }) {
  if (!location?.file) return null;
  const { row, column } = Range.fromObject(location.position).start;
  const { file } = location;
  const position = `${row + 1}:${column + 1}`;
  return { file, row, column, position, label: `${file}:${position}` };
}

// The IDE bridge keeps a plain-text copy of metadata for clipboard and older
// consumers. Show other provider-supplied descriptions even when metadata exists.
function supplementaryDescription(message, description) {
  if (!description) return null;
  const sourceAndCode = [message.source, message.code]
    .filter((part) => part != null && part !== "")
    .join(": ");
  const related = (message.relatedInformation ?? [])
    .map((item) => `${relatedFileTarget(item)?.label ?? item.uri}: ${item.message}`)
    .join("\n");
  const fallback = [sourceAndCode, related].filter(Boolean).join("\n\n");
  return description === fallback ? null : description;
}

module.exports = {
  messageSubject,
  editorForBuffer,
  renderExcerpt,
  relatedFileTarget,
  supplementaryDescription,
};
