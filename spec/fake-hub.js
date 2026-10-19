const { Range } = require("lumine");

// The severity vocabulary as the hub hands it over. Kept verbatim rather than
// reduced: the panel renders every field of it, and a spec fixture that drifts
// from the hub's model would pass while the panel showed something else.
const SEVERITIES = [
  {
    name: "error",
    label: "Error",
    rank: 0,
    lsp: 1,
    icon: "icon-stop",
    textClass: "text-error",
    gutterDot: true,
    hideWhenZero: false,
  },
  {
    name: "warning",
    label: "Warning",
    rank: 1,
    lsp: 2,
    icon: "icon-alert",
    textClass: "text-warning",
    gutterDot: true,
    hideWhenZero: false,
  },
  {
    name: "info",
    label: "Info",
    rank: 2,
    lsp: 3,
    icon: "icon-info",
    textClass: "text-info",
    gutterDot: true,
    hideWhenZero: false,
  },
  {
    name: "hint",
    label: "Hint",
    rank: 3,
    lsp: 4,
    icon: "icon-light-bulb",
    textClass: "text-hint",
    gutterDot: false,
    hideWhenZero: true,
  },
];

/**
 * Puts messages into the shape the hub guarantees: a `Range` position and a key.
 * Nothing reaches a UI without passing through the hub's `normalizeMessages`.
 * @param {Array} messages
 * @returns {Array} The same array
 */
function normalize(messages) {
  for (const message of messages) {
    const { location } = message;
    if (!(location.position instanceof Range)) {
      location.position = Range.fromObject(location.position);
    }
    if (!message.linterName) {
      message.linterName = "spec";
    }
    message.key = `${message.linterName}$${location.file}$${message.excerpt}$${location.position.toString()}`;
  }
  return messages;
}

/**
 * A stand-in for the linter hub's handle.
 *
 * `messages()` is read on every call rather than captured, so a spec can swap
 * the whole set the way a publish does.
 * @param {Object} options
 * @returns {Object} A hub handle
 */
function fakeHub({ messages = () => [], current = null, editor = () => null } = {}) {
  const resolved = new WeakMap();
  return {
    getMessages: () => messages(),
    getCurrentMessages: () => (current ? current() : messages()),
    // `null`, never `undefined`: the contract says `TextEditor | null`, and a
    // stand-in that is loose about it lets the real thing be too.
    getCursorEditor: () => editor() ?? null,
    getSeverities: () => SEVERITIES,
    revealMessage: () => {},
    deleteMessages: () => {},
    nextMessage: () => {},
    previousMessage: () => {},
    clearMessages: () => {},
    isLintingDisabled: () => false,
    getDescription(message) {
      const { description } = message;
      if (typeof description === "string") return description || null;
      return resolved.has(message) ? resolved.get(message) : null;
    },
    hasLazyDescription(message) {
      return typeof message.description === "function" && !resolved.has(message);
    },
    async resolveDescription(message) {
      if (typeof message.description !== "function") return this.getDescription(message);
      if (resolved.has(message)) return resolved.get(message);
      const text = await message.description();
      resolved.set(message, text || null);
      return resolved.get(message);
    },
  };
}

module.exports = { SEVERITIES, normalize, fakeHub };
