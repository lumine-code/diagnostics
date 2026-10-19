const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(root, rel));
// The keymap/menu files are JSONC (JSON with comments and trailing commas).
// Strip whole-line comments and trailing commas before JSON.parse so the tests
// can validate their structure without pulling in a JSONC parser.
const parseJsonc = (rel) =>
  JSON.parse(
    read(rel)
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/,(\s*[}\]])/g, "$1"),
  );

// The front end was extracted from `linter`, which keeps the hub. These guard
// the boundary: every command, config key and selector this package ships is
// its own, and nothing it needs was left behind.
describe("diagnostics package assets", () => {
  it("ships keymaps and menus as JSONC, not CSON or plain JSON", () => {
    expect(exists("keymaps/main.jsonc")).toBe(true);
    expect(exists("menus/main.jsonc")).toBe(true);
    expect(exists("keymaps/main.json")).toBe(false);
    expect(exists("menus/main.json")).toBe(false);
  });

  it("claims alt-l for the reveal tier, on its own command", () => {
    const keymap = parseJsonc("keymaps/main.jsonc");
    expect(keymap["lumine-workspace"]["alt-l"]).toBe("diagnostics:toggle-focus");
    // The panel's own keys sit under its root class, never at workspace scope.
    expect(keymap[".diagnostics"]["escape"]).toBe("core:cancel");
    expect(keymap["lumine-workspace"]["escape"]).toBeUndefined();
  });

  it("names only its own commands, in the menu and the keymap", () => {
    const files = ["menus/main.jsonc", "keymaps/main.jsonc"];
    for (const file of files) {
      const source = read(file);
      expect(source).not.toContain("linter:");
    }
    const menu = parseJsonc("menus/main.jsonc");
    const flat = JSON.stringify(menu);
    expect(flat).toContain("diagnostics:toggle");
    // Menu entries must use the singular `command` key.
    expect(flat).not.toContain('"commands"');
  });

  it("puts the row copy commands in a context menu, fenced by separators", () => {
    const menu = parseJsonc("menus/main.jsonc");
    const rows = menu["context-menu"][".diagnostics .diagnostics-row"];
    expect(rows[0].type).toBe("separator");
    expect(rows[rows.length - 1].type).toBe("separator");
    expect(rows.map((item) => item.command).filter(Boolean)).toEqual([
      "diagnostics:copy-description",
      "diagnostics:copy-details",
    ]);
  });

  it("ships a CSS stylesheet built on custom properties, not Less", () => {
    expect(exists("styles/main.css")).toBe(true);
    const css = read("styles/main.css");
    expect(css).toContain("var(--");
    // Check the code, not the explanatory header comment, for Less leftovers.
    const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(cssWithoutComments).not.toContain('@import "ui-variables"');
    expect(cssWithoutComments).not.toMatch(/\bfade\(|\bcontrast\(|\blighten\(|\bdarken\(/);
  });

  it("carries the panel and the status tile, and none of the hub's decorations", () => {
    const css = read("styles/main.css");
    expect(css).toContain(".diagnostics {");
    expect(css).toContain(".diagnostics-status {");
    // Underlines, gutter dots and the hover surface stayed with the hub.
    expect(css).not.toContain(".diagnostics-text");
    expect(css).not.toContain(".diagnostics-line-number");
    expect(css).not.toContain(".diagnostics-hover");
  });

  it("resolves the row height to a length, because the panel reads it back", () => {
    const css = read("styles/main.css");
    expect(css).toMatch(/--diagnostics-row-height:\s*[\d.]+(em|px|rem)/);
  });

  it("is named `diagnostics` and declares the seam it lives on", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.name).toBe("diagnostics");
    expect(pkg.author).toBe("lumine-code");
    expect(pkg.repository).toBe("https://github.com/lumine-code/diagnostics");
    expect(pkg.dependencies["@lumine-code/etch"]).toBeDefined();
    expect(pkg.providedServices["linter.ui"].versions["1.0.0"]).toBe("provideLinterUI");
    expect(pkg.consumedServices["status-bar"].versions["^2.0.0"]).toBe("consumeStatusBar");
    expect(pkg.deserializers.Diagnostics).toBe("deserializePanel");
    // A deserializer runs during window startup without activating the package,
    // so what it needs is built in `initialize`. Exporting one is part of
    // declaring the other.
    expect(typeof require("../lib/main").initialize).toBe("function");
  });

  it("scopes every config key to itself", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(Object.keys(pkg.configSchema).sort()).toEqual(["defaultSortMethod", "statusMode"]);
    for (const file of fs.readdirSync(path.join(root, "lib"))) {
      if (!/\.jsx?$/.test(file)) continue;
      const source = read(path.join("lib", file));
      for (const key of Object.keys(pkg.configSchema)) {
        expect(source).not.toContain(`"linter.${key}"`);
      }
    }
  });

  // The hub is reached through the handle it hands over, never by reaching into
  // another package's files.
  it("requires nothing from the hub's checkout", () => {
    for (const file of fs.readdirSync(path.join(root, "lib"))) {
      if (!/\.jsx?$/.test(file)) continue;
      expect(read(path.join("lib", file))).not.toMatch(/require\(["'][.]{2}\/[.]{2}\//);
      expect(read(path.join("lib", file))).not.toContain('"linter:');
    }
  });
});
