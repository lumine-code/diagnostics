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
describe("linter-panel package assets", () => {
  it("ships keymaps and menus as JSONC, not CSON or plain JSON", () => {
    expect(exists("keymaps/main.jsonc")).toBe(true);
    expect(exists("menus/main.jsonc")).toBe(true);
    expect(exists("keymaps/main.json")).toBe(false);
    expect(exists("menus/main.json")).toBe(false);
  });

  it("claims alt-l for the reveal tier, on its own command", () => {
    const keymap = parseJsonc("keymaps/main.jsonc");
    expect(keymap["lumine-workspace"]["alt-l"]).toBe("linter-panel:toggle-focus");
    // The panel's own keys sit under its root class, never at workspace scope.
    expect(keymap[".linter-panel"]["escape"]).toBe("core:cancel");
    expect(keymap["lumine-workspace"]["escape"]).toBeUndefined();
  });

  it("names only its own commands, in the menu and the keymap", () => {
    const files = ["menus/main.jsonc", "keymaps/main.jsonc"];
    for (const file of files) {
      const source = read(file);
      // `linter:` would be the hub's namespace. `linter-panel:` starts with it,
      // so the check has to look for the colon that ends the bare name.
      expect(source.replace(/linter-panel:/g, "")).not.toContain("linter:");
    }
    const menu = parseJsonc("menus/main.jsonc");
    const flat = JSON.stringify(menu);
    expect(flat).toContain("linter-panel:toggle");
    // Menu entries must use the singular `command` key.
    expect(flat).not.toContain('"commands"');
  });

  it("puts the row copy commands in a context menu, fenced by separators", () => {
    const menu = parseJsonc("menus/main.jsonc");
    const rows = menu["context-menu"][".linter-panel .linter-row"];
    expect(rows[0].type).toBe("separator");
    expect(rows[rows.length - 1].type).toBe("separator");
    expect(rows.map((item) => item.command).filter(Boolean)).toEqual([
      "linter-panel:copy-description",
      "linter-panel:copy-details",
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
    expect(css).toContain(".linter-panel {");
    expect(css).toContain(".linter-status {");
    // Underlines, gutter dots and the hover surface stayed with the hub.
    expect(css).not.toContain(".linter-text");
    expect(css).not.toContain(".linter-line-number");
    expect(css).not.toContain(".linter-hover");
  });

  it("resolves the row height to a length, because the panel reads it back", () => {
    const css = read("styles/main.css");
    expect(css).toMatch(/--linter-row-height:\s*[\d.]+(em|px|rem)/);
  });

  it("is named `linter-panel` and declares the seam it lives on", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.name).toBe("linter-panel");
    expect(pkg.author).toBe("lumine-code");
    expect(pkg.repository).toBe("https://github.com/lumine-code/linter-panel");
    expect(pkg.dependencies["@lumine-code/etch"]).toBeDefined();
    expect(pkg.providedServices["linter.ui"].versions["1.0.0"]).toBe("provideLinterUI");
    expect(pkg.consumedServices["status-bar"].versions["^2.0.0"]).toBe("consumeStatusBar");
    expect(pkg.deserializers.LinterPanel).toBe("deserializePanel");
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
    }
  });
});
