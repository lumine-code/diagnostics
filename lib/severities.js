// The severity vocabulary, as the hub hands it over.
//
// The model itself belongs to `linter` — array order is precedence order, and a
// fifth tier is added there and nowhere else. This wraps whatever arrives in the
// lookups the two surfaces need, so neither hardcodes a tier the hub might not
// agree with.

class Severities {
  /**
   * @param {Array} records - The hub's ordered severity records
   */
  constructor(records = []) {
    this.records = records;
    this.byName = new Map(records.map((record) => [record.name, record]));
    // Precomputed per-severity cell class, so it is not rebuilt in the render
    // loop.
    this.classes = new Map(
      records.map((record) => [
        record.name,
        `diagnostics-severity ${record.textClass} icon ${record.icon}`,
      ]),
    );
    // A severity outside the model sorts after every known one rather than
    // producing NaN. The hub validates only in dev mode on two of its three
    // intake paths, so this is reachable in a release build.
    this.unknownRank = records.length;
  }

  /**
   * Looks up a severity record. Null rather than a fallback, so every call site
   * has to state how it degrades.
   * @param {*} name
   * @returns {Object|null}
   */
  get(name) {
    return this.byName.get(name) || null;
  }

  /**
   * @param {*} name
   * @returns {string} The class list for a severity cell.
   */
  classFor(name) {
    return this.classes.get(name) || "diagnostics-severity";
  }

  rankOf(name) {
    const record = this.byName.get(name);
    return record ? record.rank : this.unknownRank;
  }

  /**
   * Total comparator for two severity names, most severe first.
   * @param {*} a
   * @param {*} b
   * @returns {number}
   */
  compare(a, b) {
    return this.rankOf(a) - this.rankOf(b);
  }
}

// The linter service supplies this vocabulary once it attaches. Keep the same
// baseline locally so the status-bar tile is useful from the first paint,
// before that service has connected and before any editor is open.
const DEFAULT_SEVERITIES = [
  {
    name: "error",
    label: "Error",
    rank: 0,
    lsp: 1,
    icon: "icon-stop",
    textClass: "text-error",
    hideWhenZero: false,
  },
  {
    name: "warning",
    label: "Warning",
    rank: 1,
    lsp: 2,
    icon: "icon-alert",
    textClass: "text-warning",
    hideWhenZero: false,
  },
  {
    name: "info",
    label: "Info",
    rank: 2,
    lsp: 3,
    icon: "icon-info",
    textClass: "text-info",
    hideWhenZero: false,
  },
  {
    name: "hint",
    label: "Hint",
    rank: 3,
    lsp: 4,
    icon: "icon-light-bulb",
    textClass: "text-hint",
    hideWhenZero: true,
  },
];

module.exports = { DEFAULT_SEVERITIES, Severities };
